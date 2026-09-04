import duckdb, os
con=duckdb.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)),'keepalive.duckdb'))
con.execute("SET memory_limit='6GB'; SET threads=6;")
def show(t,sql):
    rows=con.execute(sql).fetchall(); cols=[d[0] for d in con.description]
    print("\n== %s =="%t); print("  "+" | ".join("%-19s"%c[:19] for c in cols))
    for r in rows[:60]: print("  "+" | ".join("%-19s"%("%.4g"%v if isinstance(v,float) else str(v)) for v in r))
# decile of expenses inside the cohort, then the fundraising signal inside each decile
con.execute("""
CREATE OR REPLACE TABLE strat AS
SELECT *, ntile(10) OVER (ORDER BY expenses) AS size_decile
FROM cohort WHERE cost_per_dollar_raised IS NOT NULL AND contributions > 0
""")
show("within each expense decile: does spending more to raise a dollar mean dying more?", """
SELECT size_decile,
       count(*) orgs,
       round(min(expenses),0) lo, round(max(expenses),0) hi,
       round(100.0*sum(CASE WHEN cost_per_dollar_raised<0.05 THEN survived END)
             / nullif(sum(CASE WHEN cost_per_dollar_raised<0.05 THEN 1 END),0),2) surv_under5c,
       round(100.0*sum(CASE WHEN cost_per_dollar_raised>=0.05 AND cost_per_dollar_raised<0.15 THEN survived END)
             / nullif(sum(CASE WHEN cost_per_dollar_raised>=0.05 AND cost_per_dollar_raised<0.15 THEN 1 END),0),2) surv_5to15c,
       round(100.0*sum(CASE WHEN cost_per_dollar_raised>=0.15 THEN survived END)
             / nullif(sum(CASE WHEN cost_per_dollar_raised>=0.15 THEN 1 END),0),2) surv_over15c
FROM strat GROUP BY 1 ORDER BY 1
""")
show("same table, pooled across deciles, weighting each decile equally", """
WITH per AS (
  SELECT size_decile,
    avg(CASE WHEN cost_per_dollar_raised<0.05 THEN survived END) a,
    avg(CASE WHEN cost_per_dollar_raised>=0.05 AND cost_per_dollar_raised<0.15 THEN survived END) b,
    avg(CASE WHEN cost_per_dollar_raised>=0.15 THEN survived END) c
  FROM strat GROUP BY 1)
SELECT round(100*avg(a),2) surv_under5c, round(100*avg(b),2) surv_5to15c, round(100*avg(c),2) surv_over15c,
       round(100*(avg(b)-avg(a)),2) gap_b_minus_a, round(100*(avg(c)-avg(a)),2) gap_c_minus_a
FROM per
""")
show("runway inside each expense decile, so the runway claim is not a size claim", """
SELECT size_decile, count(*) orgs, round(median(expenses),0) med_spend,
  round(100.0*sum(CASE WHEN runway_months<3 THEN survived END)/nullif(sum(CASE WHEN runway_months<3 THEN 1 END),0),2) surv_thin,
  round(100.0*sum(CASE WHEN runway_months>=3 AND runway_months<12 THEN survived END)/nullif(sum(CASE WHEN runway_months>=3 AND runway_months<12 THEN 1 END),0),2) surv_3to12,
  round(100.0*sum(CASE WHEN runway_months>=12 THEN survived END)/nullif(sum(CASE WHEN runway_months>=12 THEN 1 END),0),2) surv_over12
FROM strat GROUP BY 1 ORDER BY 1
""")
show("pooled runway effect, decile-weighted", """
WITH per AS (SELECT size_decile,
  avg(CASE WHEN runway_months<3 THEN survived END) thin,
  avg(CASE WHEN runway_months>=3 AND runway_months<12 THEN survived END) mid,
  avg(CASE WHEN runway_months>=12 THEN survived END) fat
FROM strat GROUP BY 1)
SELECT round(100*avg(thin),2) thin, round(100*avg(mid),2) mid, round(100*avg(fat),2) fat,
       round(100*(avg(mid)-avg(thin)),2) mid_minus_thin FROM per
""")
