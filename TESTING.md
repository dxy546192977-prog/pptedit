# Testing

PPTedit uses Node.js syntax checks plus integration tests for the installer, Next.js redirect helper, demo save contract, and asset boundary.

```bash
npm run check
npm test
```

The demo should also be checked in preview and edit modes at desktop and mobile viewport sizes. New editor behavior should include a focused regression assertion in `scripts/test-install-h5-editor.mjs` or a dedicated test file.
