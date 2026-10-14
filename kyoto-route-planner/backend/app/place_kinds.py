"""Classify breaks and meals from facility evidence, never from route themes."""
import re


def is_cafe(place):
    tags = place.tags or {}
    if tags.get("amenity") == "cafe" or tags.get("venue_type") == "cafe":
        return True
    if tags.get("amenity") in {"restaurant", "fast_food", "food_court"}:
        return False
    text = place.name + " " + place.category
    return bool(re.search(r"カフェ|喫茶|珈琲|コーヒー|\bcaf[eé]\b|\bcoffee\b", text, re.I)) and not re.search(r"レストラン|食堂|定食", text)


def is_meal_place(place):
    if is_cafe(place):
        return False
    text = place.name + " " + place.category
    if re.search(r"アイスクリーム|ソフトクリーム|和菓子|洋菓子|口福堂|ドーナツ|コンビニ|セブン[イー]レブン|ファミリーマート|ローソン|キヨスク|KIOSK", text, re.I):
        return False
    if re.search(r"市場|商店街", place.category):
        return False
    return (place.tags.get("amenity") in {"restaurant", "fast_food", "food_court"}
            or place.genre_code.startswith("01")
            or bool(re.search(r"飲食|レストラン|食堂|料理|冷麺|そば|麺|寿司|焼肉|グルメ", text)))
