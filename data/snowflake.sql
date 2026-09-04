-- Keepalive in Snowflake.
--
-- This is the warehouse path. It is the same analysis data/analyse.py runs locally in
-- DuckDB, expressed once in Snowflake SQL, plus the two things only a warehouse can do:
-- score every candidate signal inside every size decile in one statement, and run a
-- language model next to the data with Cortex instead of pulling rows out to an app.
--
-- Run it with the SQL REST API, which has never accepted a password, so authenticate with
-- key pair JWT:
--   POST https://<ORG>-<ACCOUNT>.snowflakecomputing.com/api/v2/statements
--   Authorization: Bearer <RS256 JWT>       X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT
--
-- Nothing here reads a Marketplace listing. The rows come from our own download of the
-- IRS Statistics of Income extracts, which are public domain, because Marketplace terms
-- do not permit redistributing a dataset and this site serves per-organisation figures.

CREATE DATABASE IF NOT EXISTS KEEPALIVE;
CREATE SCHEMA IF NOT EXISTS KEEPALIVE.IRS;
USE SCHEMA KEEPALIVE.IRS;

CREATE FILE FORMAT IF NOT EXISTS CSV_HEADER
  TYPE = CSV FIELD_OPTIONALLY_ENCLOSED_BY = '"' SKIP_HEADER = 1
  NULL_IF = ('', 'NULL') EMPTY_FIELD_AS_NULL = TRUE;

CREATE STAGE IF NOT EXISTS RAW FILE_FORMAT = CSV_HEADER;
-- PUT file://data/raw/*eoextract*.csv @RAW AUTO_COMPRESS=TRUE;   (snowsql or the driver)

-- One filing per organisation per fiscal year. A tax period is YYYYMM, and the same period
-- can appear in more than one processing year when a return is amended, so the newest
-- processing year wins.
CREATE OR REPLACE TABLE FILINGS AS
SELECT * EXCLUDE (rn) FROM (
  SELECT ein,
         tax_pd,
         FLOOR(tax_pd / 100)::INT                      AS fy,
         form,
         revenue, contributions, expenses,
         COALESCE(cash, 0) + COALESCE(savings, 0)      AS liquid,
         net_assets, pro_fundraising_fees, direct_fundraising_expense,
         gross_fundraising_income, processed_year,
         ROW_NUMBER() OVER (
           PARTITION BY ein, FLOOR(tax_pd / 100)
           ORDER BY processed_year DESC, tax_pd DESC
         ) AS rn
  FROM FILINGS_RAW
  WHERE ein IS NOT NULL AND tax_pd > 190000
) WHERE rn = 1;

-- The cohort: every long-form filer with a fiscal 2018 or 2019 return, its runway at the
-- start, what it spent to raise a dollar, and whether the same EIN files again for fiscal
-- 2022 or later. Fiscal 2022 is the cut because it is the last year covered by two
-- processing years of the extract, so a late filer is not scored as a closure.
CREATE OR REPLACE TABLE COHORT AS
WITH base AS (
  SELECT * EXCLUDE (rn) FROM (
    SELECT f.*,
           liquid / (expenses / 12.0)                                  AS runway_months,
           IFF(COALESCE(contributions, 0) + COALESCE(gross_fundraising_income, 0) > 0,
               (COALESCE(pro_fundraising_fees, 0)
                + COALESCE(direct_fundraising_expense, 0))
               / (COALESCE(contributions, 0)
                  + COALESCE(gross_fundraising_income, 0)), NULL)      AS cost_per_dollar_raised,
           ROW_NUMBER() OVER (PARTITION BY ein ORDER BY fy)            AS rn
    FROM FILINGS f
    WHERE form = '990' AND expenses > 0 AND fy IN (2018, 2019)
  ) WHERE rn = 1
),
later AS (SELECT DISTINCT ein FROM FILINGS WHERE fy >= 2022)
SELECT b.*,
       IFF(l.ein IS NOT NULL, 1, 0)                     AS survived,
       NTILE(10) OVER (ORDER BY b.expenses)             AS size_decile
FROM base b LEFT JOIN later l ON l.ein = b.ein;

-- The finding, both signals inside every decile, in one statement. This is the query the
-- site's two tables are drawn from.
SELECT size_decile,
       COUNT(*)                                                        AS orgs,
       ROUND(MEDIAN(expenses))                                         AS median_spend,
       ROUND(100 * AVG(IFF(runway_months < 3, survived, NULL)), 2)      AS runway_thin,
       ROUND(100 * AVG(IFF(runway_months BETWEEN 3 AND 12, survived, NULL)), 2) AS runway_mid,
       ROUND(100 * AVG(IFF(runway_months > 12, survived, NULL)), 2)     AS runway_fat,
       ROUND(100 * AVG(IFF(cost_per_dollar_raised < 0.05, survived, NULL)), 2)  AS raise_under5c,
       ROUND(100 * AVG(IFF(cost_per_dollar_raised BETWEEN 0.05 AND 0.15, survived, NULL)), 2) AS raise_5to15c,
       ROUND(100 * AVG(IFF(cost_per_dollar_raised > 0.15, survived, NULL)), 2)   AS raise_over15c
FROM COHORT
GROUP BY size_decile
ORDER BY size_decile;

-- Cortex, doing the work in the warehouse rather than in the app.
--
-- 1. The IRS gives an organisation a letter code, not a sentence a donor understands.
--    AI_CLASSIFY reads the name and puts it in a donor-facing bucket, 300,000 rows at a
--    time, with no round trip to any application.
CREATE OR REPLACE TABLE ORG_CAUSE AS
SELECT o.ein,
       o.name,
       AI_CLASSIFY(
         o.name,
         ['feeding people', 'housing and shelter', 'schools and tutoring',
          'health care and clinics', 'mental health and crisis support',
          'animal rescue', 'environment and conservation', 'arts and culture',
          'legal aid and civil rights', 'disaster relief',
          'youth programmes', 'religious congregation', 'sport and recreation',
          'grantmaking foundation', 'something else']
       ):labels[0]::STRING AS donor_cause
FROM ORGS o
WHERE o.name IS NOT NULL;

-- 2. One honest sentence per organisation, written from every year it filed at once.
--    AI_AGG sees the whole group, which a row by row prompt cannot.
CREATE OR REPLACE TABLE ORG_STORY AS
SELECT ein,
       AI_AGG(
         'fiscal ' || fy || ': spent ' || expenses ||
         ', held ' || liquid || ' in cash, ' ||
         ROUND(runway_months, 2) || ' months of runway',
         'Write one sentence describing how this organisation''s cash position moved across
          these years. State only figures present in the input. No adjectives that a number
          could carry. Do not recommend anything.'
       ) AS story
FROM (
  SELECT ein, fy, expenses, liquid, liquid / (expenses / 12.0) AS runway_months
  FROM FILINGS WHERE form = '990' AND expenses > 0 AND fy >= 2018
)
GROUP BY ein;

-- 3. Plain language straight into a filter, which is the thing a donor actually types.
--    AI_FILTER keeps the rows that match an intent nobody coded a column for.
SELECT c.ein, o.name, c.expenses, c.runway_months
FROM COHORT c JOIN ORGS o ON o.ein = c.ein
WHERE c.runway_months < 3
  AND AI_FILTER(PROMPT('Does this organisation help children learn to read? {0}', o.name))
ORDER BY c.expenses
LIMIT 40;
