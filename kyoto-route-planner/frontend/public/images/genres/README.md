# Generated genre illustrations

Eight original images were generated with the built-in `image_gen` tool on 2026-10-15, one call per asset. Full final prompts and asset metadata are in [manifest.json](manifest.json).

These are fictional watercolor/gouache genre illustrations, not photographs or verified depictions of a particular facility, its food, or its view. The app labels them `AI生成・ジャンルイメージ` and prefers available real photographs. Station placeholders continue to use the neutral train icon when no real photo is available.

Added images: garden cafe, bakery, izakaya, udon, onsen, aquarium, observation deck, and coast. The cafe image supplements the existing cafe artwork; a stable hash of the venue name chooses one of the two versions. Classification uses the venue's own name, category and tags, never the itinerary story or the user's free-text wishes.

All eight outputs were visually reviewed for their subjects, central crop, consistency with the existing watercolor style, and absence of names/logos/text. The WebP files are format-only optimized equivalents, preserving the original dimensions and composition. PNG originals are kept in `frontend/.local/generated-genre-originals/` and are not bundled into the public site. No images are generated at runtime.
