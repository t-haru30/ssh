import re

with open('app/main.py', 'r', encoding='utf-8') as f:
    content = f.read()

# import ÇÃí«â¡
content = content.replace(
    'from app.ekispert import search_route',
    'from app.ekispert import search_route\nfrom app.osrm import fetch_detailed_polyline'
)

# ç¿ïWê∂ê¨ïîï™ÇÃíuä∑
old_coords = '''                        coordinates=[
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ],'''

new_coords = '''                        coordinates=await fetch_detailed_polyline([
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ]),'''

content = content.replace(old_coords, new_coords)

with open('app/main.py', 'w', encoding='utf-8') as f:
    f.write(content)
