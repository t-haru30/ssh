"""Conservative regular-hour constraints. Unrecognized syntax stays unknown."""
import re
from datetime import date

DAYS=['Mo','Tu','We','Th','Fr','Sa','Su']

def osm_windows(value, day:date):
    if not value:return None
    if value=='24/7':return [(0,1440)]
    if any(s in value for s in ['PH','SH','sunrise','sunset','"','(', 'Jan','Dec']):return None
    windows=[];recognized=False;today=DAYS[day.weekday()]
    for clause in value.split(';'):
        match=re.fullmatch(r'\s*((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)?\s*((?:\d{2}:\d{2}-\d{2}:\d{2})(?:\s*,\s*\d{2}:\d{2}-\d{2}:\d{2})*|off|closed)\s*',clause)
        if not match:return None
        days,times=match.groups();active=set(DAYS) if not days else set()
        for part in (days or '').split(','):
            if '-' in part:
                a,b=part.split('-');i=DAYS.index(a)
                for _ in range(7):
                    active.add(DAYS[i])
                    if DAYS[i]==b:break
                    i=(i+1)%7
            elif part:active.add(part)
        recognized=True
        if today not in active:continue
        if times in {'off','closed'}:windows=[];continue
        for a,b in re.findall(r'(\d{2}:\d{2})-(\d{2}:\d{2})',times):
            def minute(s):
                h,m=map(int,s.split(':'))
                if h>24 or m>59 or h==24 and m:raise ValueError()
                return h*60+m
            try:start,end=minute(a),minute(b)
            except ValueError:return None
            windows.append((start,end if end>start else end+1440))
    return sorted(windows) if recognized else None

def google_regular_windows(hours, day:date):
    if not isinstance(hours,dict) or not isinstance(hours.get('periods'),list):return None
    target=(day.weekday()+1)%7;windows=[]
    try:
        for period in hours['periods']:
            start,end=period['open'],period.get('close')
            if not end:
                return [(0,1440)] if start.get('day')==0 and start.get('hour',0)==0 else None
            a=(start['day']-target)%7*1440+start.get('hour',0)*60+start.get('minute',0)
            b=a+((end['day']-start['day'])%7)*1440+end.get('hour',0)*60+end.get('minute',0)-start.get('hour',0)*60-start.get('minute',0)
            if b<=a:b+=7*1440
            for shift in [0,-7*1440]:
                x,y=a+shift,b+shift
                if x<1440 and y>0:windows.append((max(0,x),y))
        return sorted(windows)
    except (KeyError,TypeError,ValueError):return None

def visit_fits(place, day, minute, dwell, google_hours=None):
    windows=google_regular_windows(google_hours,day) if google_hours is not None else osm_windows(place.tags.get('opening_hours',''),day)
    return windows is None or any(a<=minute and minute+dwell<=b for a,b in windows)
