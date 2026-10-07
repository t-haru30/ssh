import re

with open('app/overpass.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

with open('app/overpass.py', 'w', encoding='utf-8') as f:
    for line in lines:
        stripped = line.strip()
        if stripped == 'normalized_tags = {':
            f.write('        normalized_tags = {\n')
        elif stripped == 'themes: set[str] = set()':
            f.write('        themes: set[str] = set()\n')
        elif stripped.startswith('amenity ='):
            f.write('        amenity = str(tags.get("amenity", "")).casefold()\n')
        elif stripped.startswith('religion ='):
            f.write('        religion = str(tags.get("religion", "")).casefold()\n')
        elif stripped.startswith('historic ='):
            f.write('        historic = str(tags.get("historic", "")).casefold()\n')
        elif stripped.startswith('natural ='):
            f.write('        natural = str(tags.get("natural", "")).casefold()\n')
        elif stripped.startswith('leisure ='):
            f.write('        leisure = str(tags.get("leisure", "")).casefold()\n')
        elif stripped.startswith('shop ='):
            f.write('        shop = str(tags.get("shop", "")).casefold()\n')
        elif stripped.startswith('tourism ='):
            f.write('        tourism = str(tags.get("tourism", "")).casefold()\n')
        else:
            f.write(line)
