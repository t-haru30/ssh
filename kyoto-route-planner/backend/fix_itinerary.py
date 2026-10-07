import re

with open('app/itinerary.py', 'r', encoding='utf-8') as f:
    content = f.read()

# _find_best_route の後にある中途半端な origin = next( から始まる日帰りロジックを修正
# 正規表現で eturn best より後、def plan_itinerary がない状態になっているため、
# 関数宣言を追加する

content = content.replace(
    '''    return best


    origin = next(''',
    '''    return best

async def plan_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
    origin = next('''
)

with open('app/itinerary.py', 'w', encoding='utf-8') as f:
    f.write(content)
