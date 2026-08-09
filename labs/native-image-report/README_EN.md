# Case 02 · Native Image Report

[中文](README.md) · [Run](run.js)

A text model first creates a complete report under a program-owned schema.
An image model then designs the final text-bearing report natively. The program
owns validation and narrative selection, and can own OCR, visual QA, targeted
retries, and save after the host supplies those integrations.

```bash
npm run lab:native-image
```

The sample uses a mock URI and mock OCR text. It does not generate an image, run
OCR, edit an image, or save a deliverable, and contains no production assets.
