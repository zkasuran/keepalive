# Data sources and the clause that lets us use each one

Keepalive publishes numbers about real organisations, so every input is recorded here with
the sentence that grants the right to use and republish analysis of it. A source whose
grant cannot be quoted does not ship.

## IRS Statistics of Income annual extracts of Form 990 and Form 990-EZ financial data

- Files: `https://www.irs.gov/pub/irs-soi/<YY>eoextract990.zip` and
  `<YY>eoextractez.zip` for processing years 2018 to 2024, plus the field documentation
  workbook `<YY>eofinextractdoc.xlsx`.
- Index page: <https://www.irs.gov/statistics/soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data>
- What we take: 3,697,515 filings covering 700,873 employer identification numbers.
- Grant: a work of the United States federal government. IRS.gov states, under
  <https://www.irs.gov/privacy-disclosure/copyright-status-and-citation-policy>, that
  "IRS.gov material is generally in the public domain and not subject to copyright
  protection" and "may be reproduced or otherwise used, in whole or in part, without
  permission". Form 990 returns of exempt organisations are themselves required to be
  made public under 26 U.S.C. 6104(b) and (d).

## IRS Exempt Organizations Business Master File extract

- Files: `https://www.irs.gov/pub/irs-soi/eo{1,2,3,4,_xx}.csv`
- Index page: <https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf>
- What we take: the roster of 1,957,340 organisations, for name, city, state, subsection
  and NTEE classification.
- Grant: same public domain status as above.

## Snowflake Marketplace, when the warehouse path is enabled

- Listing: Snowflake Public Data, the free tier, used for cross checking our own load and
  for Cortex work over filing text.
- Constraint, quoted and obeyed: Snowflake states that "By default, our terms of service
  (the contract you agree to when mounting a listing) do not allow for data
  redistribution. Our data is intended for internal use."
- Therefore: no Marketplace row is shipped in this repository or served by the site. Every
  per-organisation figure the site displays comes from our own IRS download, which is
  public domain. Only aggregates computed in the warehouse leave it.

## Fonts

- Inter, Instrument Serif and JetBrains Mono, served by Google Fonts, all under the SIL
  Open Font License 1.1, which permits use and embedding.

## Nothing else

No scraped pages, no third party ratings, no purchased list, no personal data. Keepalive
holds no account for anyone and stores nothing about a visitor.
