import type { Origin } from './types';
import { walkingEstimateMinutes } from './dayTrip';
import './walkingEstimate.css';

export function WalkingEstimate({from,to}: {from:Origin;to:Origin}) {
  const minutes=walkingEstimateMinutes(from,to);
  if(minutes===null)return null;
  return <p className="walking-estimate" title="直線距離に迂回分1.3を掛け、分速80mで計算しています。実際の道路や通行条件によって変わります。">
    <strong>徒歩なら約{minutes}分</strong><small>距離からの概算</small>
  </p>;
}
