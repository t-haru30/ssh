import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {WalkingEstimate} from './WalkingEstimate';
const from={name:'出発',latitude:35,longitude:135};
afterEach(cleanup);
it('shows a nearby walk using the existing detour and speed approximation',()=>{
  render(<WalkingEstimate from={from} to={{...from,latitude:35.01}} />);
  expect(screen.getByText('徒歩なら約19分')).toBeTruthy();
  expect(screen.getByText('距離からの概算')).toBeTruthy();
});
it('does not suggest walking for coincident, distant or invalid coordinates',()=>{
  for(const to of [from,{...from,latitude:36},{...from,latitude:NaN}]){
    const view=render(<WalkingEstimate from={from} to={to} />);
    expect(view.container.textContent).toBe('');view.unmount();
  }
});
