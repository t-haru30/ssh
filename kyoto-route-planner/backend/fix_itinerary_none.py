import sys

with open('app/itinerary.py', 'r', encoding='utf-8') as f:
    content = f.read()

# _find_best_route で例外が発生したり、見つからなかったりした場合、
# 'places' キーなどが欠落することがあるため修正する

# test_itinerary.py の AssertionError: 'NoneType' object has no attribute 'places'
# に対処するため、ItineraryCandidate に合わせて返すように修正

content = content.replace('''
    if best is None:
        # 経路が見つからない場合のフォールバック（直線距離順など、本来はもっと凝るべきだが一旦空で返す）
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 0,
            "arrival_at": None,
            "calls": calls
        }
''', '''
    if best is None:
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 9999,
            "arrival_at": None,
            "calls": calls
        }
''')

with open('app/itinerary.py', 'w', encoding='utf-8') as f:
    f.write(content)
