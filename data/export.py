#!/usr/bin/env python3
"""Turn the warehouse into the static files the Keepalive site reads.

Nothing is served from a database at runtime. The site is plain files on a CDN plus a
handful of functions for the AI, the audio and the chain call, so a lookup costs one
fetch of a shard and search costs one fetch per query token.

Layout under web/data:
  meta.json          headline counts, the survival tables, the band definitions
  o/<0..1023>.json   organisation records, keyed by EIN, bucketed by EIN modulo 1024
  i/<0..2047>.json   inverted index, name token -> list of EINs, bucketed by token hash
"""
import json
import os
import re
import shutil
import unicodedata

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "keepalive.duckdb")
WEB = os.path.abspath(os.path.join(HERE, "..", "public", "data"))
ORG_SHARDS = 1024
IDX_SHARDS = 2048
# A token that points at half the sector is still worth indexing, because search scores
# on how many query tokens hit and a truncated list silently breaks that.
POSTING_CAP = 20000

# NTEE major groups, the IRS classification of what an organisation is for.
NTEE = {
    "A": "Arts, culture and humanities",
    "B": "Education",
    "C": "Environment",
    "D": "Animals",
    "E": "Health care",
    "F": "Mental health and crisis intervention",
    "G": "Disease and medical research adjacent",
    "H": "Medical research",
    "I": "Crime and legal aid",
    "J": "Employment",
    "K": "Food, agriculture and nutrition",
    "L": "Housing and shelter",
    "M": "Disaster relief and public safety",
    "N": "Recreation and sports",
    "O": "Youth development",
    "P": "Human services",
    "Q": "International and foreign affairs",
    "R": "Civil rights and advocacy",
    "S": "Community and economic development",
    "T": "Grantmaking foundations",
    "U": "Science and technology",
    "V": "Social science",
    "W": "Public and societal benefit",
    "X": "Religion",
    "Y": "Mutual and membership benefit",
    "Z": "Unclassified",
}

STOP = {
    "the", "of", "and", "for", "inc", "incorporated", "a", "an", "to", "in", "at",
    "on", "association", "foundation", "trust", "org", "organization", "co",
    "company", "llc", "corp", "corporation", "society", "club", "group", "usa",
    "us", "national", "american", "america",
}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def tokens(name):
    out = []
    for w in norm(name).split():
        if len(w) < 2:
            continue
        out.append(w)
    # keep stopwords out of the index but never let a name index to nothing
    kept = [w for w in out if w not in STOP]
    return kept or out


def tok_shard(tok):
    h = 2166136261
    for ch in tok:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h % IDX_SHARDS


def r2(v, nd=2):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, nd)


def money(v):
    """Dollars as a plain integer. Cents on a tax return are noise here."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(round(f))


def main():
    con = duckdb.connect(DB)
    con.execute("SET memory_limit='6GB'; SET threads=6;")

    print("assembling the per organisation series")
    con.execute(
        """
        CREATE OR REPLACE TABLE app_filings AS
        SELECT f.ein, f.fy, f.form,
               f.revenue, f.contributions, f.program_revenue, f.expenses,
               coalesce(f.cash,0) + coalesce(f.savings,0)            AS liquid,
               f.cash, f.savings, f.assets, f.liabilities, f.net_assets,
               f.employees, f.grants_out, f.officer_comp,
               coalesce(f.pro_fundraising_fees,0)
                 + coalesce(f.direct_fundraising_expense,0)          AS fundraising_cost,
               CASE WHEN f.form='990' AND f.expenses>0
                    THEN (coalesce(f.cash,0)+coalesce(f.savings,0)) / (f.expenses/12.0) END
                 AS runway_months,
               CASE WHEN (coalesce(f.contributions,0)
                          + coalesce(f.gross_fundraising_income,0)) > 0
                    THEN (coalesce(f.pro_fundraising_fees,0)
                          + coalesce(f.direct_fundraising_expense,0))
                         / (coalesce(f.contributions,0)
                            + coalesce(f.gross_fundraising_income,0)) END
                 AS cost_per_dollar_raised
        FROM filings f
        WHERE f.expenses > 0 AND f.fy BETWEEN 2017 AND 2024
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE app_orgs AS
        WITH latest AS (
          SELECT * EXCLUDE (rn) FROM (
            SELECT a.*, row_number() OVER (PARTITION BY ein ORDER BY fy DESC) rn
            FROM app_filings a
          ) WHERE rn = 1
        )
        SELECT l.ein, o.name, o.city, o.state, o.ntee,
               upper(substr(coalesce(o.ntee,'Z'),1,1)) AS ntee_group,
               o.subsection, o.ruling,
               l.fy AS latest_fy, l.form AS latest_form,
               l.expenses, l.revenue, l.contributions, l.program_revenue,
               l.liquid, l.net_assets, l.assets, l.liabilities,
               l.employees, l.grants_out, l.officer_comp, l.fundraising_cost,
               l.runway_months, l.cost_per_dollar_raised
        FROM latest l JOIN orgs o USING (ein)
        WHERE o.name IS NOT NULL AND l.fy >= 2019
        """
    )
    n_orgs = con.execute("SELECT count(*) FROM app_orgs").fetchone()[0]
    print("  %d organisations" % n_orgs)

    # Peer position: size decile across the whole universe, then the runway percentile
    # inside the organisation's own NTEE group and size decile.
    print("computing peer position")
    con.execute(
        """
        CREATE OR REPLACE TABLE app_orgs2 AS
        WITH d AS (
          SELECT *, ntile(10) OVER (ORDER BY expenses) AS size_decile FROM app_orgs
        )
        SELECT *,
               percent_rank() OVER (
                 PARTITION BY ntee_group, size_decile ORDER BY runway_months
               ) AS runway_pct_in_peers,
               count(*) OVER (PARTITION BY ntee_group, size_decile) AS peer_n
        FROM d
        """
    )
    con.execute("DROP TABLE app_orgs")
    con.execute("ALTER TABLE app_orgs2 RENAME TO app_orgs")
    main_export(con, n_orgs)


def main_export(con, n_orgs):
    print("writing shards to %s" % WEB)
    for sub in ("o", "i"):
        p = os.path.join(WEB, sub)
        shutil.rmtree(p, ignore_errors=True)
        os.makedirs(p, exist_ok=True)

    series = {}
    q = """
        SELECT ein, fy, form, revenue, contributions, expenses,
               liquid, runway_months, cost_per_dollar_raised
        FROM app_filings
        WHERE ein IN (SELECT ein FROM app_orgs) AND fy >= 2018
        ORDER BY ein, fy
    """
    # One compact row per fiscal year: year, form, revenue, contributions, expenses,
    # liquid money, months of runway, cents to raise a dollar.
    for row in con.execute(q).fetchall():
        ein = int(row[0])
        series.setdefault(ein, []).append(
            [
                int(row[1]),
                0 if row[2] == "990" else 1,
                money(row[3]),
                money(row[4]),
                money(row[5]),
                money(row[6]),
                r2(row[7], 2),
                r2(row[8], 4),
            ]
        )
    print("  series for %d organisations" % len(series))

    buckets = [dict() for _ in range(ORG_SHARDS)]
    index = [dict() for _ in range(IDX_SHARDS)]
    size_of = {}
    q = """
        SELECT ein, name, city, state, ntee, ntee_group, subsection, latest_fy,
               latest_form, size_decile, runway_pct_in_peers, peer_n,
               employees, grants_out, officer_comp, net_assets, assets, liabilities,
               program_revenue
        FROM app_orgs
    """
    for (
        ein, name, city, state, ntee, grp, subsec, lfy, lform, decile, pct, peer_n,
        employees, grants_out, officer_comp, net_assets, assets, liabilities, prog_rev
    ) in con.execute(q).fetchall():
        ein = int(ein)
        rec = {
            "e": ein,
            "n": (name or "").strip(),
            "c": (city or "").strip().title(),
            "s": (state or "").strip(),
            "t": (ntee or "").strip(),
            "g": grp,
            "sub": subsec,
            "fy": int(lfy),
            "f": lform,
            "d": int(decile) if decile is not None else None,
            "p": r2(pct, 3),
            "pn": int(peer_n) if peer_n is not None else None,
            "emp": money(employees),
            "go": money(grants_out),
            "oc": money(officer_comp),
            "na": money(net_assets),
            "as": money(assets),
            "li": money(liabilities),
            "pr": money(prog_rev),
            "h": series.get(ein, []),
        }
        buckets[ein % ORG_SHARDS][str(ein)] = rec
        h = series.get(ein, [])
        size_of[ein] = (h[-1][4] or 0) if h else 0
        for tok in set(tokens(rec["n"])):
            index[tok_shard(tok)].setdefault(tok, []).append(ein)

    for i, b in enumerate(buckets):
        with open(os.path.join(WEB, "o", "%d.json" % i), "w") as fh:
            json.dump(b, fh, separators=(",", ":"))
    kept = 0
    for i, b in enumerate(index):
        # Search scores by how many query tokens hit, so truncating a common token's
        # posting list breaks the intersection and a real name stops being findable.
        # Keep everything, then order each list by spending so the organisation a person
        # is most likely to mean comes first.
        trimmed = {k: sorted(v, key=lambda e: -size_of.get(e, 0))[:POSTING_CAP]
                   for k, v in b.items()}
        kept += sum(len(v) for v in trimmed.values())
        with open(os.path.join(WEB, "i", "%d.json" % i), "w") as fh:
            json.dump(trimmed, fh, separators=(",", ":"))
    print("  %d org shards, %d index shards, %d postings" % (ORG_SHARDS, IDX_SHARDS, kept))
    write_gift_buckets(con)
    write_meta(con, n_orgs)
    con.close()


def write_gift_buckets(con):
    """Precompute, per cause and per state, the organisations where a gift buys the most
    time. Days of runway added scales linearly with the amount given, so the ranking does
    not depend on how much the visitor types, only on how small the organisation is.

    Filters, all of them stated on the page so nobody has to guess:
      still filing for fiscal 2022 or later, so the organisation is alive
      annual spending of at least 25,000 dollars, so it is a real operation
      under six months of runway, because that is the population under strain
    """
    out = os.path.join(WEB, "g")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    con.execute(
        """
        CREATE OR REPLACE TABLE gift_pool AS
        SELECT ein, name, city, state, ntee_group, expenses, runway_months,
               cost_per_dollar_raised, latest_fy, contributions
        FROM app_orgs
        WHERE latest_fy >= 2022 AND latest_form = '990'
              AND expenses >= 25000 AND runway_months IS NOT NULL
              AND runway_months < 6 AND runway_months >= 0
              AND name IS NOT NULL AND length(trim(name)) > 3
        """
    )
    n = con.execute("SELECT count(*) FROM gift_pool").fetchone()[0]
    print("  gift pool: %d organisations" % n)

    groups = [r[0] for r in con.execute(
        "SELECT DISTINCT ntee_group FROM gift_pool WHERE ntee_group IS NOT NULL ORDER BY 1"
    ).fetchall()]
    states = [r[0] for r in con.execute(
        "SELECT DISTINCT state FROM gift_pool WHERE state IS NOT NULL AND length(state)=2 ORDER BY 1"
    ).fetchall()]

    written = 0
    for g in [""] + groups:
        for s in [""] + states:
            where = ["1=1"]
            if g:
                where.append("ntee_group = '%s'" % g.replace("'", ""))
            if s:
                where.append("state = '%s'" % s.replace("'", ""))
            w = " AND ".join(where)
            cols = ("ein, name, city, state, ntee_group, expenses, runway_months, "
                    "cost_per_dollar_raised, latest_fy")

            def pull(order):
                return [
                    {
                        "e": int(r[0]), "n": (r[1] or "").strip(),
                        "c": (r[2] or "").title(), "s": r[3], "g": r[4],
                        "x": money(r[5]), "r": r2(r[6], 2), "cd": r2(r[7], 4),
                        "fy": int(r[8]),
                    }
                    for r in con.execute(
                        "SELECT %s FROM gift_pool WHERE %s ORDER BY %s LIMIT 40"
                        % (cols, w, order)
                    ).fetchall()
                ]

            payload = {
                # smallest first, because days of runway added is 365 * gift / spending
                "leverage": pull("expenses ASC, ein"),
                # thinnest first among organisations big enough to have staff to lose
                "urgent": pull("runway_months ASC, expenses DESC, ein"),
                "n": con.execute(
                    "SELECT count(*) FROM gift_pool WHERE %s" % w
                ).fetchone()[0],
            }
            if not payload["leverage"]:
                continue
            with open(os.path.join(out, "%s-%s.json" % (g or "all", s or "us")), "w") as fh:
                json.dump(payload, fh, separators=(",", ":"))
            written += 1
    print("  %d gift buckets" % written)


def write_meta(con, n_orgs):
    def rows(sql):
        rs = con.execute(sql).fetchall()
        cols = [d[0] for d in con.description]
        return [dict(zip(cols, [r2(v, 4) if isinstance(v, float) else v for v in r])) for r in rs]

    # The cohort the finding is measured on, rebuilt here so meta.json is self contained.
    con.execute(
        """
        CREATE OR REPLACE TABLE meta_cohort AS
        WITH base AS (
          SELECT * EXCLUDE (rn) FROM (
            SELECT f.*,
                   (coalesce(cash,0)+coalesce(savings,0)) / (expenses/12.0) AS runway_months,
                   CASE WHEN (coalesce(contributions,0)
                              + coalesce(gross_fundraising_income,0)) > 0
                        THEN (coalesce(pro_fundraising_fees,0)
                              + coalesce(direct_fundraising_expense,0))
                             / (coalesce(contributions,0)
                                + coalesce(gross_fundraising_income,0)) END
                     AS cost_per_dollar_raised,
                   row_number() OVER (PARTITION BY ein ORDER BY fy) rn
            FROM filings f
            WHERE form='990' AND expenses>0 AND fy IN (2018, 2019)
          ) WHERE rn = 1
        ),
        later AS (SELECT DISTINCT ein FROM filings WHERE fy >= 2022)
        SELECT b.*, CASE WHEN l.ein IS NOT NULL THEN 1 ELSE 0 END AS survived,
               ntile(10) OVER (ORDER BY b.expenses) AS size_decile
        FROM base b LEFT JOIN later l USING (ein)
        """
    )

    meta = {
        "orgs": n_orgs,
        "filings_total": con.execute("SELECT count(*) FROM filings").fetchone()[0],
        "filings_in_app": con.execute("SELECT count(*) FROM app_filings").fetchone()[0],
        "roster_total": con.execute("SELECT count(*) FROM orgs").fetchone()[0],
        "gift_pool": con.execute("SELECT count(*) FROM gift_pool").fetchone()[0],
        "fy_range": list(con.execute("SELECT min(fy), max(fy) FROM app_filings").fetchone()),
        "ntee": NTEE,
        "states": [
            r[0] for r in con.execute(
                "SELECT DISTINCT state FROM gift_pool WHERE length(state)=2 ORDER BY 1"
            ).fetchall()
        ],
        "causes": [
            {"g": r[0], "label": NTEE.get(r[0], "Other"), "n": r[1]}
            for r in con.execute(
                "SELECT ntee_group, count(*) FROM gift_pool WHERE ntee_group IS NOT NULL "
                "GROUP BY 1 ORDER BY 2 DESC"
            ).fetchall()
        ],
        "coverage": rows(
            "SELECT fy, count(*) filings FROM filings WHERE fy BETWEEN 2017 AND 2024 "
            "GROUP BY 1 ORDER BY 1"
        ),
        "runway_distribution": rows(
            """
            SELECT count(*) n, round(median(runway_months),2) p50,
                   round(quantile_cont(runway_months,0.25),2) p25,
                   round(quantile_cont(runway_months,0.75),2) p75,
                   round(100.0*sum(CASE WHEN runway_months<1 THEN 1 ELSE 0 END)/count(*),2) pct_under_1,
                   round(100.0*sum(CASE WHEN runway_months<3 THEN 1 ELSE 0 END)/count(*),2) pct_under_3,
                   round(100.0*sum(CASE WHEN runway_months<6 THEN 1 ELSE 0 END)/count(*),2) pct_under_6
            FROM app_filings WHERE runway_months IS NOT NULL AND fy BETWEEN 2018 AND 2022
            """
        )[0],
        "cohort": rows(
            "SELECT count(*) orgs, sum(survived) survived, "
            "round(100.0*sum(survived)/count(*),2) pct_survived FROM meta_cohort"
        )[0],
        "survival_by_runway": rows(
            """
            SELECT CASE WHEN runway_months<1 THEN 'under 1 month'
                        WHEN runway_months<3 THEN '1 to 3 months'
                        WHEN runway_months<6 THEN '3 to 6 months'
                        WHEN runway_months<12 THEN '6 to 12 months'
                        WHEN runway_months<24 THEN '1 to 2 years'
                        ELSE 'over 2 years' END AS band,
                   CASE WHEN runway_months<1 THEN 1 WHEN runway_months<3 THEN 2
                        WHEN runway_months<6 THEN 3 WHEN runway_months<12 THEN 4
                        WHEN runway_months<24 THEN 5 ELSE 6 END AS ord,
                   count(*) orgs, round(100.0*sum(survived)/count(*),2) pct_survived
            FROM meta_cohort GROUP BY 1,2 ORDER BY 2
            """
        ),
        "survival_by_size": rows(
            """
            SELECT CASE WHEN expenses<100000 THEN 'under $100k'
                        WHEN expenses<500000 THEN '$100k to $500k'
                        WHEN expenses<2000000 THEN '$500k to $2m'
                        WHEN expenses<10000000 THEN '$2m to $10m'
                        ELSE 'over $10m' END AS band,
                   CASE WHEN expenses<100000 THEN 1 WHEN expenses<500000 THEN 2
                        WHEN expenses<2000000 THEN 3 WHEN expenses<10000000 THEN 4
                        ELSE 5 END AS ord,
                   count(*) orgs, round(median(runway_months),2) median_runway,
                   round(100.0*sum(survived)/count(*),2) pct_survived
            FROM meta_cohort GROUP BY 1,2 ORDER BY 2
            """
        ),
        "decile_runway": rows(
            """
            SELECT size_decile, count(*) orgs, round(median(expenses),0) median_spend,
              round(100.0*sum(CASE WHEN runway_months<3 THEN survived END)
                    /nullif(sum(CASE WHEN runway_months<3 THEN 1 END),0),2) thin,
              round(100.0*sum(CASE WHEN runway_months>=3 AND runway_months<12 THEN survived END)
                    /nullif(sum(CASE WHEN runway_months>=3 AND runway_months<12 THEN 1 END),0),2) mid,
              round(100.0*sum(CASE WHEN runway_months>=12 THEN survived END)
                    /nullif(sum(CASE WHEN runway_months>=12 THEN 1 END),0),2) fat
            FROM meta_cohort GROUP BY 1 ORDER BY 1
            """
        ),
        "decile_fundraising": rows(
            """
            SELECT size_decile, count(*) orgs, round(median(expenses),0) median_spend,
              round(100.0*sum(CASE WHEN cost_per_dollar_raised<0.05 THEN survived END)
                    /nullif(sum(CASE WHEN cost_per_dollar_raised<0.05 THEN 1 END),0),2) under5c,
              round(100.0*sum(CASE WHEN cost_per_dollar_raised>=0.05
                                   AND cost_per_dollar_raised<0.15 THEN survived END)
                    /nullif(sum(CASE WHEN cost_per_dollar_raised>=0.05
                                   AND cost_per_dollar_raised<0.15 THEN 1 END),0),2) c5to15,
              round(100.0*sum(CASE WHEN cost_per_dollar_raised>=0.15 THEN survived END)
                    /nullif(sum(CASE WHEN cost_per_dollar_raised>=0.15 THEN 1 END),0),2) over15c
            FROM meta_cohort WHERE cost_per_dollar_raised IS NOT NULL AND contributions > 0
            GROUP BY 1 ORDER BY 1
            """
        ),
    }
    os.makedirs(WEB, exist_ok=True)
    with open(os.path.join(WEB, "meta.json"), "w") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    print("  meta.json written, %d bytes" % os.path.getsize(os.path.join(WEB, "meta.json")))


if __name__ == "__main__":
    main()
