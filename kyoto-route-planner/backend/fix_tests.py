import re

with open('tests/test_overpass.py', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace(
    '[tourism~"^(attraction|museum|gallery|viewpoint|theme_park|zoo)$"]',
    '[tourism~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|hotel|hostel|guest_house|motel|apartment|camp_site)$"]'
)

with open('tests/test_overpass.py', 'w', encoding='utf-8') as f:
    f.write(content)
