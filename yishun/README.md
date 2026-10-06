# Yishun alignment

`trial for vibecoding.shp` — one surveyed drain centreline, 40 points, 523.7 m,
in Yishun. Now `DRN-80041 · Yishun Trial Drain` in the register.

## Read this before trusting the coordinates

The file arrived as a bare `.shp`. A shapefile is really a set — `.shp` geometry,
`.dbf` attributes, `.shx` index, `.prj` coordinate system — and only the geometry
came. That has two consequences:

**No name came with it.** There is no attribute table, so "Yishun Trial Drain" is
a name we chose, not one the surveyor recorded.

**No coordinate system came with it.** The file says nothing about what its
numbers mean. They are easting ~28,839–29,156 and northing ~44,386–44,704, which
is **SVY21 (EPSG:3414)**, Singapore's national grid, in metres. Three things
agree on that reading:

- the magnitude — WGS84 would be ~1.42 and ~103.84, and nothing else is close
- it lands in Yishun, which is what the folder is called
- its length measured on the grid (522.4 m) and across the converted sphere
  (523.7 m) agree to a quarter of a percent, which a wrong projection would not
  manage

Read as degrees instead, it would plot off the coast of Antarctica — so this is
a guess that fails loudly rather than quietly. Still, **if a `.prj` ever turns up,
check it against this.**

## Doing it again

```bash
python tools/shapefile_to_job.py yishun/alignment.shp --name "Some Drain" --queue
cd cfpi && npm run sync:assets
```

`--dry-run` first prints where it thinks the drain is, with a maps link to check
before anything is written.
