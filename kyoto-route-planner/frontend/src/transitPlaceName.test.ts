import {expect,it} from "vitest";
import {transitPlaceName} from "./transitPlaceName";
const points = [{name:"二条城",latitude:35.011972,longitude:135.7512038}, {name:"京都モダンテラス",latitude:35.01407611,longitude:135.78063413}];
it("replaces coordinate labels with the matching facility, preserving station names", () => {
  expect(transitPlaceName("35.011972,135.7512038,wgs84,1000",points)).toBe("二条城");
  expect(transitPlaceName("35.014076,135.780634,wgs84,1000",points)).toBe("京都モダンテラス");
  expect(transitPlaceName("東山(京都府)",points)).toBe("東山(京都府)");
  expect(transitPlaceName("36,136,wgs84,1000",points)).toBe("経由地点");
});
