import unittest
from app.discovery import DiscoverRequest, build_discover_routes, distinct_venues
from app.models import CatalogPlace, Origin


def place(id, name, latitude=35.001):
    return CatalogPlace(id=id, name=name, latitude=latitude, longitude=135,
                        category="史跡", region="京都府", address="", description="")


class DistinctDiscoveryPlacesTests(unittest.TestCase):
    def test_directional_views_do_not_duplicate_automatic_routes(self):
        views = [place("south", "南東から見た二条城東南隅櫓の眺め"),
                 place("west", "西から見た二条城東南隅櫓の眺め", 35.002)]
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府",
                                  origin=Origin(name="駅", latitude=35, longitude=135))
        routes = build_discover_routes(request, (*views,place('canonical','二条城東南隅櫓')))["routes"]
        assert len(routes) == 1
        assert [p["place_id"] for p in routes[0]["spots"]] == ["canonical"]
        assert views[1].name == "西から見た二条城東南隅櫓の眺め"


    def test_identity_is_conservative_and_geographically_bounded(self):
        pool = [place("a", "Ａ 公園"), place("b", "a公園"),
                place("far", "a公園", 35.02), place("other", "a公園資料館")]
        assert [p.id for p in distinct_venues(pool)] == ["a", "far", "other"]
        assert len(distinct_venues([place("a", "二条城東南隅櫓"), place("b", "二条城西南隅櫓")])) == 2
