import unittest

from app.models import Place
from scripts.generate_prefecture_routes import (
    AREAS,
    STATIONS,
    _lunch_insertion_index,
    _lunch_spot,
    _add_course_lunch,
    _select_routes,
    _route,
    _spot,
)


KYOTO = next(area for area in AREAS if area.id == "kyoto")


def candidate(place_id: str, latitude: float, longitude: float, score: float = 50.0):
    place = Place(
        id=place_id,
        name=place_id,
        category="飲食店" if place_id.startswith("food") else "観光名所",
        description="",
        access_point="",
        latitude=latitude,
        longitude=longitude,
        themes=["food" if place_id.startswith("food") else "all"],
    )
    return {"place": place, "score": score}


class LunchPlanningTests(unittest.TestCase):
    def test_lunch_goes_before_the_first_stop_arriving_after_noon(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate("morning-1", station_lat + 0.01, station_lon),
            candidate("morning-2", station_lat + 0.02, station_lon),
            candidate("afternoon-1", station_lat + 0.55, station_lon),
            candidate("afternoon-2", station_lat + 0.56, station_lon),
        ]
        self.assertEqual(_lunch_insertion_index(KYOTO, ordered), 2)

    def test_long_first_leg_can_make_the_second_stop_the_lunch_anchor(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate("far-morning", station_lat + 0.35, station_lon),
            candidate("late-arrival", station_lat + 0.36, station_lon),
            candidate("later-stop", station_lat + 0.37, station_lon),
            candidate("last-stop", station_lat + 0.38, station_lon),
        ]
        self.assertEqual(_lunch_insertion_index(KYOTO, ordered), 1)

    def test_routes_that_arrive_before_noon_put_lunch_after_the_last_stop(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate(f"near-{index}", station_lat + index * 0.002, station_lon)
            for index in range(1, 5)
        ]
        self.assertEqual(_lunch_insertion_index(KYOTO, ordered), len(ordered))
        index, lunch = _lunch_spot(KYOTO, ordered, [], 3)
        self.assertEqual(index, len(ordered))
        self.assertEqual(lunch["name"], "昼食: 要検討")
        self.assertEqual((lunch["lat"], lunch["lng"]), (
            ordered[-1]["place"].latitude,
            ordered[-1]["place"].longitude,
        ))

    def test_nearest_food_is_used_and_reason_reports_walking_estimate(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate(f"near-{index}", station_lat + index * 0.002, station_lon)
            for index in range(1, 5)
        ]
        anchor = ordered[-1]["place"]
        foods = [
            candidate("food-far", anchor.latitude, anchor.longitude + 0.012, 100.0),
            candidate("food-near", anchor.latitude, anchor.longitude + 0.001, 10.0),
        ]
        index, lunch = _lunch_spot(KYOTO, ordered, foods, 0)
        self.assertEqual(index, len(ordered))
        self.assertEqual(lunch["place_id"], "food-near")
        self.assertIn("徒歩目安約", lunch["reason"])

    def test_search_radius_expands_to_two_kilometers(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate(f"near-{index}", station_lat + index * 0.002, station_lon)
            for index in range(1, 5)
        ]
        anchor = ordered[-1]["place"]
        food = candidate("food-expanded", anchor.latitude, anchor.longitude + 0.015)
        index, lunch = _lunch_spot(KYOTO, ordered, [food], 0)
        self.assertEqual(index, len(ordered))
        self.assertEqual(lunch["place_id"], "food-expanded")

    def test_no_restaurant_candidates_do_not_prevent_full_day_routes(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        candidates = [
            candidate(
                f"spot-{index}",
                station_lat + (index % 5) * 0.01,
                station_lon + (index // 5) * 0.01,
                100 - index,
            )
            for index in range(17)
        ]
        routes = _select_routes(KYOTO, candidates, [])
        full_day = [route for route in routes if route["pattern"] == "full_day"]
        half_day = [route for route in routes if route["pattern"] == "half_day"]
        self.assertEqual(len(full_day), 2)
        self.assertTrue(all(sum(spot["role"] == "lunch" for spot in route["spots"]) == 1 for route in full_day))
        self.assertTrue(all(
            next(spot for spot in route["spots"] if spot["role"] == "lunch")["name"] == "昼食: 要検討"
            for route in full_day
        ))
        self.assertTrue(all(not any(spot["role"] == "lunch" for spot in route["spots"]) for route in half_day))

    def test_half_day_generation_pattern_gets_lunch_when_display_course_is_full_day(self):
        station_lat, station_lon = STATIONS[KYOTO.id][1:]
        ordered = [
            candidate("far-1", station_lat + 0.45, station_lon),
            candidate("far-2", station_lat + 0.46, station_lon),
            candidate("far-3", station_lat + 0.47, station_lon),
        ]
        stops = [_spot(item, "stop") for item in ordered]
        route = _route(KYOTO, 0, "half_day", ordered, stops)
        self.assertEqual(route["course"], "full_day")

        updated = _add_course_lunch(KYOTO, route, ordered, [], 0)

        self.assertEqual(updated["pattern"], "half_day")
        self.assertEqual(updated["course"], "full_day")
        self.assertEqual(sum(spot["role"] == "lunch" for spot in updated["spots"]), 1)


if __name__ == "__main__":
    unittest.main()
