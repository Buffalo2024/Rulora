# Case 03 · Stable Image Reproduction

[中文](README.md) · [Run](run.js)

An image model creates the first content-aware design with maximum-length sample
copy. The intended program flow then freezes text slots, capacity, typography and pixel bounds
for deterministic reproduction of future short-copy variants.

```bash
npm run lab:stable-image
```

This case targets short stable copy; dense native reports belong to Case 02.
The current script checks character capacity, but fusion, OCR, and pixel-difference
results are mock values. A real renderer and QA engine are not bundled yet.
