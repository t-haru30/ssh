import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PreviewTransit } from "./PreviewTransit";
afterEach(cleanup);

it("keeps the duration while omitting the movement label", () => {
  render(
    <ol>
      <PreviewTransit
        from="京都駅"
        to="稲荷駅"
        minutes={19}
        loading={false}
        places={[]}
      />
    </ol>,
  );

  expect(screen.getByText("約19分")).toBeTruthy();
  expect(screen.queryByText(/移動 約/)).toBeNull();
});
it('compares public transport with a local walking estimate without calling a route API',()=>{
  const from={name:'博物館',latitude:35,longitude:135},to={name:'公園',latitude:35.01,longitude:135};
  render(<ol><PreviewTransit from={from.name} to={to.name} fromPoint={from} toPoint={to} minutes={25} loading={false} places={[from,to]} transit={{type:'transit',from_name:from.name,to_name:to.name,mode:'public_transport',duration_minutes:25,is_estimate:false,start_time:null,end_time:null,fare_yen:230}} /></ol>);
  expect(screen.getByText('約25分')).toBeTruthy();
  expect(screen.getByText('徒歩なら約19分')).toBeTruthy();
  expect(screen.getByText('距離からの概算')).toBeTruthy();
});
