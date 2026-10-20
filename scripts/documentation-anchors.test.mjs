import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchors, previewDocuments, relativeLinks } from './documentation-links.mjs';

test('preview documentation fragments name retained destination anchors', () => {
  for (const path of previewDocuments) {
    for (const link of relativeLinks(path)) {
      if (link.fragment)
        assert.ok(
          anchors(link.destination).has(link.fragment),
          `${path}: ${link.destination}#${link.fragment}`,
        );
    }
  }
});
