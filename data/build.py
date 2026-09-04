#!/usr/bin/env python3
"""Build the Keepalive warehouse from the IRS public filings, then measure runway.

Inputs, both US federal government works in the public domain:
  data/raw/<YY>eoextract990.csv    SOI annual extract of Form 990 financial data
  data/raw/<YY>eoextractez.csv     the same for Form 990-EZ filers
  data/raw/eo{1,2,3,4,xx}.csv      Exempt Organizations Business Master File

Output: data/keepalive.duckdb with one row per (ein, fiscal year) plus a roster
table carrying name, state and NTEE category.

The measure we care about is months of runway: liquid money on hand divided by
one month of spending. Overhead ratio, the number donors are told to judge on,
says nothing about whether an organisation survives the year.
"""
import glob
import os
import re
import sys

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
DB = os.path.join(HERE, "keepalive.duckdb")

# The canonical shape we want, plus for each field the IRS column names that have
# carried it. Names drift between processing years (tax_pd became taxpd on the EZ
# extract, for one), so the loader reads each file's header and picks what is there
# rather than assuming one spelling.
FIELDS = [
    ("ein", ["EIN", "ein"], "BIGINT"),
    ("tax_pd", ["tax_pd", "taxpd", "TAX_PD"], "INTEGER"),
    ("subsection", ["subseccd"], "INTEGER"),
    ("revenue", ["totrevenue", "totrevnue"], "DOUBLE"),
    ("contributions", ["totcntrbgfts", "totcntrbs"], "DOUBLE"),
    ("program_revenue", ["totprgmrevnue", "prgmservrev"], "DOUBLE"),
    ("expenses", ["totfuncexpns", "totexpns"], "DOUBLE"),
    ("cash", ["nonintcashend"], "DOUBLE"),
    ("savings", ["svngstempinvend"], "DOUBLE"),
    ("assets", ["totassetsend"], "DOUBLE"),
    ("liabilities", ["totliabend"], "DOUBLE"),
    ("net_assets", ["totnetassetend", "totnetassetsend"], "DOUBLE"),
    ("unrestricted_net_assets", ["unrstrctnetasstsend"], "DOUBLE"),
    ("officer_comp", ["compnsatncurrofcr"], "DOUBLE"),
    ("other_wages", ["othrsalwages"], "DOUBLE"),
    ("pro_fundraising_fees", ["profndraising"], "DOUBLE"),
    ("direct_fundraising_expense", ["lessdirfndrsng", "direxpns"], "DOUBLE"),
    ("gross_fundraising_income", ["grsincfndrsng", "grsrevnuefndrsng"], "DOUBLE"),
    ("employees", ["noemplyeesw3cnt"], "DOUBLE"),
]

# Grants paid out is three columns on the long form and absent on the EZ.
GRANT_COLS = ["grntstogovt", "grnsttoindiv", "grntstofrgngovt"]


def header_of(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return [c.strip().strip('"') for c in fh.readline().rstrip("\n").split(",")]


def select_for(path, is_ez):
    """Build the SELECT list for one file from the columns it actually has."""
    have = {c.lower(): c for c in header_of(path)}
    parts = []
    for name, candidates, typ in FIELDS:
        src = next((have[c.lower()] for c in candidates if c.lower() in have), None)
        if src is None:
            parts.append("NULL::%s AS %s" % (typ, name))
        else:
            parts.append('TRY_CAST("%s" AS %s) AS %s' % (src, typ, name))
    present = [have[c] for c in GRANT_COLS if c in have]
    if present:
        parts.append(
            "("
            + " + ".join('coalesce(TRY_CAST("%s" AS DOUBLE), 0)' % c for c in present)
            + ") AS grants_out"
        )
    else:
        parts.append("NULL::DOUBLE AS grants_out")
    parts.append("'%s' AS form" % ("990EZ" if is_ez else "990"))
    return ",\n    ".join(parts)


def sources():
    """Every extract file on disk, tagged with the processing year in its name."""
    out = []
    for path in sorted(glob.glob(os.path.join(RAW, "*eoextract*.csv"))):
        base = os.path.basename(path)
        m = re.match(r"(\d\d)eoextract", base)
        if not m:
            continue
        proc_year = 2000 + int(m.group(1))
        is_ez = "ez" in base.lower().replace("eoextract", "", 1)
        out.append((path, proc_year, is_ez))
    return out


def build():
    if os.path.exists(DB):
        os.remove(DB)
    con = duckdb.connect(DB)
    con.execute("SET memory_limit='6GB'; SET threads=6; SET preserve_insertion_order=false;")

    files = sources()
    if not files:
        sys.exit("no extract CSVs under %s, run fetch.sh first" % RAW)

    print("loading %d extract files" % len(files))
    con.execute("DROP TABLE IF EXISTS filings_raw")
    first = True
    for path, proc_year, is_ez in files:
        sel = (
            "SELECT %s, %d AS processed_year FROM read_csv_auto('%s', sample_size=400000, "
            "ignore_errors=true, all_varchar=true)" % (select_for(path, is_ez), proc_year, path)
        )
        if first:
            con.execute("CREATE TABLE filings_raw AS " + sel)
            first = False
        else:
            con.execute("INSERT INTO filings_raw BY NAME " + sel)
        n = con.execute("SELECT count(*) FROM filings_raw").fetchone()[0]
        print("  %-28s %-6s -> %10d rows total" % (os.path.basename(path), proc_year, n))

    # One filing per organisation per fiscal year. When the same period shows up in
    # more than one processing year, keep the newest, which is the amended return.
    # A tax period is stored as YYYYMM, so the fiscal year is its integer division.
    print("deduplicating to one filing per ein and fiscal year")
    con.execute(
        """
        CREATE OR REPLACE TABLE filings AS
        SELECT * EXCLUDE (rn) FROM (
          SELECT *,
                 CAST(tax_pd / 100 AS INTEGER)      AS fy,
                 row_number() OVER (
                   PARTITION BY ein, CAST(tax_pd / 100 AS INTEGER)
                   ORDER BY processed_year DESC, tax_pd DESC
                 ) AS rn
          FROM filings_raw
          WHERE ein IS NOT NULL AND tax_pd IS NOT NULL AND tax_pd > 190000
        )
        WHERE rn = 1
        """
    )

    # Business Master File: the roster. Latest row per EIN wins.
    print("loading the business master file")
    bmf_files = [
        p for p in glob.glob(os.path.join(RAW, "eo*.csv")) if re.search(r"eo(\d|_xx)\.csv$", p)
    ]
    con.execute("DROP TABLE IF EXISTS bmf_raw")
    first = True
    for path in sorted(bmf_files):
        sel = (
            "SELECT CAST(EIN AS BIGINT) AS ein, NAME AS name, CITY AS city, STATE AS state, "
            "ZIP AS zip, NTEE_CD AS ntee, TRY_CAST(SUBSECTION AS INTEGER) AS subsection, "
            "TRY_CAST(RULING AS INTEGER) AS ruling, TRY_CAST(REVENUE_AMT AS DOUBLE) AS bmf_revenue, "
            "TRY_CAST(ASSET_AMT AS DOUBLE) AS bmf_assets, FILING_REQ_CD AS filing_req "
            "FROM read_csv_auto('%s', sample_size=200000, ignore_errors=true, all_varchar=true)" % path
        )
        if first:
            con.execute("CREATE TABLE bmf_raw AS " + sel)
            first = False
        else:
            con.execute("INSERT INTO bmf_raw " + sel)
    con.execute(
        """
        CREATE OR REPLACE TABLE orgs AS
        SELECT * EXCLUDE (rn) FROM (
          SELECT *, row_number() OVER (PARTITION BY ein ORDER BY bmf_revenue DESC NULLS LAST) rn
          FROM bmf_raw WHERE ein IS NOT NULL
        ) WHERE rn = 1
        """
    )
    con.execute("DROP TABLE bmf_raw")
    con.execute("DROP TABLE filings_raw")

    print("done")
    for t in ("filings", "orgs"):
        n = con.execute("SELECT count(*) FROM %s" % t).fetchone()[0]
        print("  %-10s %10d rows" % (t, n))
    print(
        "  distinct EINs with a filing: %d"
        % con.execute("SELECT count(DISTINCT ein) FROM filings").fetchone()[0]
    )
    print(
        "  fiscal years: %s to %s"
        % con.execute("SELECT min(fy), max(fy) FROM filings").fetchone()
    )
    con.close()


if __name__ == "__main__":
    build()
