#!/usr/bin/env bash
# Pull the IRS Statistics of Income annual extracts of Form 990 financial data
# plus the Exempt Organizations Business Master File. Both are US federal
# government works, public domain.
set -u
cd "$(dirname "$0")/raw"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
for y in 18 19 20 21 22 23 24; do
  for f in "${y}eoextract990.zip" "${y}eoextractez.zip" "${y}eoextract990EZ.zip"; do
    [ -s "$f" ] && continue
    curl -sS --max-time 600 -f -H "user-agent: $UA" -o "$f" "https://www.irs.gov/pub/irs-soi/$f" \
      && echo "ok   $f $(stat -c%s "$f")" || { rm -f "$f"; echo "miss $f"; }
  done
done
for f in 24eofinextractdoc.xlsx 21eofinextractdoc.xlsx; do
  [ -s "$f" ] || curl -sS --max-time 300 -f -H "user-agent: $UA" -o "$f" "https://www.irs.gov/pub/irs-soi/$f" && echo "ok   $f"
done
for f in eo1.csv eo2.csv eo3.csv eo4.csv eo_xx.csv; do
  [ -s "$f" ] || curl -sS --max-time 600 -f -H "user-agent: $UA" -o "$f" "https://www.irs.gov/pub/irs-soi/$f" && echo "ok   $f $(stat -c%s "$f" 2>/dev/null)"
done
echo "DONE"; ls -la
