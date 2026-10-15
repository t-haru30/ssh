import unittest

from app.image_search import CommercialImage
from app.models import Place
from app.station_photos import is_station_place, station_photo_score


def image(description, filename='File:Station.jpg'):
    return CommercialImage('https://upload.wikimedia.org/Station.jpg', 'Author',
                           'https://commons.wikimedia.org/wiki/File:Station.jpg', 'CC BY-SA 4.0',
                           'https://creativecommons.org/licenses/by-sa/4.0/', description, filename, 'image/jpeg')


class StationPhotoTests(unittest.TestCase):
    def test_station_overviews_in_japanese_and_english(self):
        for name, description, filename in [
            ('名古屋駅', '西方より名古屋駅を望む', 'File:View_of_Nagoya_Station_2022.jpg'),
            ('金沢駅', '金沢駅の兼六園口外観（鼓門・もてなしドーム）', 'File:Kanazawa-STA_Kenrokuen-entrance.jpg'),
            ('盛岡駅', 'The east entrance building of Morioka Station', 'File:JR_Morioka_Station.jpg'),
            ('盛岡駅', '東北新幹線 盛岡駅の東口駅舎', 'File:盛岡駅_東口.jpg'),
        ]:
            with self.subTest(name=name):
                self.assertEqual(station_photo_score(image(description, filename), name), 3)

    def test_food_trains_and_different_station_subjects_are_rejected(self):
        for description, filename in [
            ('名古屋駅にて撮影', 'File:Tempura_kishimen_by_matsudon,giraffe_in_Nagoya_Station.jpg'),
            ('名古屋駅構内のきしめん', 'File:Station.jpg'),
            ('盛岡駅に停車中の新幹線', 'File:E6_series_Z8_train_set_at_Morioka_20220402.jpg'),
            ('盛岡駅の駅舎のそばに停車中の車両', 'File:E6_series_Z8_train_set_at_Morioka_20220402.jpg'),
            ('金沢駅の駅舎', 'File:Other_station.jpg'),
        ]:
            with self.subTest(filename=filename):
                self.assertEqual(station_photo_score(image(description, filename), '名古屋駅'), 0)
        self.assertEqual(station_photo_score(image('盛岡駅に停車中の新幹線', 'File:E6_series_Z8_train_set_at_Morioka_20220402.jpg'), '盛岡駅'), 0)
        self.assertEqual(station_photo_score(image('駅の入口と電光掲示板', 'File:Electronic_signage_of_Kanazawa_Station.jpg'), '金沢駅'), 1)

    def test_station_detection_preserves_non_station_facilities(self):
        base=Place(id='trip-arrival',name='名古屋駅',category='到着・観光の起点',description='',access_point='',latitude=35,longitude=136,themes=[])
        self.assertTrue(is_station_place(base))
        self.assertTrue(is_station_place(base.model_copy(update={'name':'金沢','category':'駅'})))
        self.assertTrue(is_station_place(base.model_copy(update={'name':'盛岡','tags':{'railway':'station'}})))
        self.assertFalse(is_station_place(base.model_copy(update={'name':'金沢城','category':'城跡'})))
