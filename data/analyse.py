#!/usr/bin/env python3
"""What actually predicts whether a small charity is still there in five years.

Runs against data/keepalive.duckdb. Prints every number it computes so the write-up
can quote them. It writes findings.json for the app and the post to read.

Two definitions used throughout:
  runway_months  (cash + savings) / (annual expenses / 12).  Money on hand over
                 one month of spending. Long-form 990 only, since Form 990-EZ does
                 not break out cash.
  survived       the same EIN has a filing for fiscal 2022 or later.

Right censoring is the trap here. The extracts stop at processing year 2024, so a
fiscal 2023 or 2024 return that was filed late is simply not in the corpus yet.
Fiscal 2022 is the last year covered by two processing years, so that is the line.
"""
import json
import os

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "keepalive.duckdb")
OUT = os.path.join(HERE, "findings.json")

con = duckdb.connect(DB)
con.execute("SET memory_limit='6GB'; SET threads=6;")
F = {}


def fmt(v):
    if isinstance(v, float):
        return "%.4g" % v
    return str(v)


def show(title, sql, keys=None):
    rows = con.execute(sql).fetchall()
    cols = [d[0] for d in con.description]
    print("\n== %s ==" % title)
    print("  " + " | ".join("%-20s" % c[:20] for c in cols))
    for r in rows[:40]:
        print("  " + " | ".join("%-20s" % fmt(v) for v in r))
    if keys:
        F[keys] = [dict(zip(cols, r)) for r in rows]
    return rows


# ---------------------------------------------------------------- coverage
show(
    "filings per fiscal year, to see where the corpus is complete",
    """
    SELECT fy, count(*) filings, count(DISTINCT ein) eins,
           sum(CASE WHEN form='990' THEN 1 ELSE 0 END) long_form
    FROM filings WHERE fy BETWEEN 2014 AND 2024 GROUP BY fy ORDER BY fy
    """,
    "coverage",
)

# ---------------------------------------------------------------- the base view
con.execute(
    """
    CREATE OR REPLACE VIEW usable AS
    SELECT f.*,
           (coalesce(cash,0) + coalesce(savings,0)) AS liquid,
           CASE WHEN expenses > 0
                THEN (coalesce(cash,0) + coalesce(savings,0)) / (expenses / 12.0) END
             AS runway_months,
           CASE WHEN (coalesce(gross_fundraising_income,0)
                      + coalesce(contributions,0)) > 0
                THEN (coalesce(pro_fundraising_fees,0)
                      + coalesce(direct_fundraising_expense,0))
                     / (coalesce(contributions,0)
                        + coalesce(gross_fundraising_income,0)) END
             AS cost_per_dollar_raised,
           CASE WHEN expenses > 0 THEN coalesce(officer_comp,0) / expenses END
             AS officer_comp_share,
           CASE WHEN revenue IS NOT NULL AND expenses IS NOT NULL
                THEN revenue - expenses END AS surplus
    FROM filings f
    WHERE form = '990' AND expenses > 0
    """
)

show(
    "runway months across every long-form filing 2018 to 2022",
    """
    SELECT count(*) n,
           round(median(runway_months),2) p50,
           round(quantile_cont(runway_months,0.10),2) p10,
           round(quantile_cont(runway_months,0.25),2) p25,
           round(quantile_cont(runway_months,0.75),2) p75,
           round(quantile_cont(runway_months,0.90),2) p90,
           round(100.0*sum(CASE WHEN runway_months < 1 THEN 1 ELSE 0 END)/count(*),2) pct_under_1_month,
           round(100.0*sum(CASE WHEN runway_months < 3 THEN 1 ELSE 0 END)/count(*),2) pct_under_3_months,
           round(100.0*sum(CASE WHEN runway_months < 6 THEN 1 ELSE 0 END)/count(*),2) pct_under_6_months
    FROM usable WHERE fy BETWEEN 2018 AND 2022 AND runway_months IS NOT NULL
    """,
    "runway_distribution",
)

# ---------------------------------------------------------------- the cohort
con.execute(
    """
    CREATE OR REPLACE TABLE cohort AS
    WITH base AS (
      SELECT * EXCLUDE (rn) FROM (
        SELECT u.*, row_number() OVER (PARTITION BY ein ORDER BY fy) rn
        FROM usable u WHERE fy IN (2018, 2019) AND runway_months IS NOT NULL
      ) WHERE rn = 1
    ),
    later AS (SELECT DISTINCT ein FROM filings WHERE fy >= 2022)
    SELECT b.*,
           o.name, o.state, o.ntee,
           CASE WHEN l.ein IS NOT NULL THEN 1 ELSE 0 END AS survived
    FROM base b
    LEFT JOIN later l USING (ein)
    LEFT JOIN orgs  o USING (ein)
    """
)

show(
    "the cohort: organisations with a 2018 or 2019 long-form filing",
    """
    SELECT count(*) orgs,
           sum(survived) still_filing_2022_or_later,
           round(100.0*sum(survived)/count(*),2) pct_survived,
           round(100.0*(1-1.0*sum(survived)/count(*)),2) pct_gone
    FROM cohort
    """,
    "cohort_overall",
)

show(
    "survival by months of runway at the start",
    """
    SELECT CASE
             WHEN runway_months < 1  THEN 'a under 1 month'
             WHEN runway_months < 3  THEN 'b 1 to 3 months'
             WHEN runway_months < 6  THEN 'c 3 to 6 months'
             WHEN runway_months < 12 THEN 'd 6 to 12 months'
             WHEN runway_months < 24 THEN 'e 1 to 2 years'
             ELSE                         'f over 2 years' END AS runway_band,
           count(*) orgs,
           round(100.0*sum(survived)/count(*),2) pct_survived,
           round(100.0*(1-1.0*sum(survived)/count(*)),2) pct_gone
    FROM cohort GROUP BY 1 ORDER BY 1
    """,
    "survival_by_runway",
)

show(
    "survival by cost to raise a dollar, the efficiency number donors are shown",
    """
    SELECT CASE
             WHEN cost_per_dollar_raised IS NULL   THEN 'z not reported'
             WHEN cost_per_dollar_raised < 0.05    THEN 'a under 5 cents'
             WHEN cost_per_dollar_raised < 0.10    THEN 'b 5 to 10 cents'
             WHEN cost_per_dollar_raised < 0.20    THEN 'c 10 to 20 cents'
             WHEN cost_per_dollar_raised < 0.35    THEN 'd 20 to 35 cents'
             ELSE                                       'e over 35 cents' END AS fundraising_band,
           count(*) orgs,
           round(100.0*sum(survived)/count(*),2) pct_survived
    FROM cohort GROUP BY 1 ORDER BY 1
    """,
    "survival_by_fundraising_cost",
)

show(
    "survival by size, because small is the real risk factor",
    """
    SELECT CASE
             WHEN expenses < 100000    THEN 'a under 100k'
             WHEN expenses < 500000    THEN 'b 100k to 500k'
             WHEN expenses < 2000000   THEN 'c 500k to 2m'
             WHEN expenses < 10000000  THEN 'd 2m to 10m'
             ELSE                           'e over 10m' END AS size_band,
           count(*) orgs,
           round(median(runway_months),2) median_runway,
           round(100.0*sum(survived)/count(*),2) pct_survived
    FROM cohort GROUP BY 1 ORDER BY 1
    """,
    "survival_by_size",
)

show(
    "runway inside the smallest band, where a single gift moves the number",
    """
    SELECT CASE
             WHEN runway_months < 1  THEN 'a under 1 month'
             WHEN runway_months < 3  THEN 'b 1 to 3 months'
             WHEN runway_months < 6  THEN 'c 3 to 6 months'
             WHEN runway_months < 12 THEN 'd 6 to 12 months'
             ELSE                         'e over 12 months' END AS runway_band,
           count(*) orgs,
           round(100.0*sum(survived)/count(*),2) pct_survived
    FROM cohort WHERE expenses < 500000 GROUP BY 1 ORDER BY 1
    """,
    "survival_small_by_runway",
)

show(
    "the two signals side by side, holding size roughly constant",
    """
    SELECT CASE WHEN expenses < 500000 THEN 'small under 500k' ELSE 'larger' END AS size_band,
           CASE WHEN runway_months < 3 THEN 'thin runway' ELSE 'runway 3 months or more' END AS runway,
           CASE WHEN cost_per_dollar_raised IS NULL THEN 'no fundraising cost reported'
                WHEN cost_per_dollar_raised < 0.10 THEN 'efficient fundraiser'
                ELSE 'expensive fundraiser' END AS efficiency,
           count(*) orgs,
           round(100.0*sum(survived)/count(*),2) pct_survived
    FROM cohort GROUP BY 1,2,3 ORDER BY 1,2,3
    """,
    "two_signals",
)

show(
    "correlation of each candidate signal with survival",
    """
    SELECT round(corr(least(runway_months,60), survived),4)          AS corr_runway,
           round(corr(ln(expenses), survived),4)                     AS corr_log_expenses,
           round(corr(least(coalesce(cost_per_dollar_raised,0),1), survived),4) AS corr_fundraising_cost,
           round(corr(officer_comp_share, survived),4)               AS corr_officer_comp_share,
           round(corr(CASE WHEN expenses>0 THEN surplus/expenses END, survived),4) AS corr_margin
    FROM cohort
    """,
    "correlations",
)

show(
    "how much one recurring gift is worth, by size band",
    """
    SELECT CASE
             WHEN expenses < 50000     THEN 'a under 50k'
             WHEN expenses < 100000    THEN 'b 50k to 100k'
             WHEN expenses < 500000    THEN 'c 100k to 500k'
             WHEN expenses < 2000000   THEN 'd 500k to 2m'
             ELSE                           'e over 2m' END AS size_band,
           count(*) orgs,
           round(median(expenses),0) median_annual_spend,
           round(median(expenses)/12.0,0) median_monthly_spend,
           round(365.0 * 600.0 / median(expenses), 1) days_of_runway_per_600_dollars
    FROM cohort GROUP BY 1 ORDER BY 1
    """,
    "gift_leverage",
)

show(
    "the thinnest organisations that are still filing, as live examples",
    """
    SELECT o.name, c.state, c.fy, round(c.runway_months,2) runway_months,
           round(c.expenses,0) annual_spend, c.survived
    FROM cohort c JOIN orgs o USING (ein)
    WHERE c.expenses BETWEEN 80000 AND 400000 AND c.runway_months < 0.5
          AND o.name IS NOT NULL AND c.survived = 1
    ORDER BY c.expenses DESC LIMIT 15
    """,
)

with open(OUT, "w") as fh:
    json.dump(F, fh, indent=2, default=str)
print("\nwrote %s" % OUT)
