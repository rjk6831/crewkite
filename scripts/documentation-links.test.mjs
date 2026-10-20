import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  destinationFile,
  previewDocuments,
  readDocument,
  relativeLinks,
} from './documentation-links.mjs';

test('preview documentation links resolve inside the repository', () => {
  for (const path of previewDocuments) {
    readDocument(path);
    for (const link of relativeLinks(path))
      assert.doesNotThrow(() => destinationFile(link.destination), `${path}: ${link.destination}`);
  }
});
