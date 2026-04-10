#!/bin/bash
# Query each calendar separately to avoid timeout from one slow calendar blocking all
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

CALS=("Calendar" "AJ Personal" "Untitled" "jonathan.gitlin@glossi.io" "gitlin.jonathan@gmail.com" "Family")
DAYS=${1:-3}

for cal in "${CALS[@]}"; do
  # Run each calendar query with a 20s timeout, in parallel
  (
    osascript -e "
tell application \"Calendar\"
  set today to current date
  set time of today to 0
  set endD to today + $DAYS * days
  set output to \"\"
  try
    set cal to calendar \"$cal\"
    set evts to (every event of cal whose start date ≥ today and start date < endD)
    repeat with evt in evts
      try
        set evtStart to start date of evt
        set evtEnd to end date of evt
        set evtName to summary of evt
        set evtLoc to \"\"
        try
          set evtLoc to location of evt
        end try
        set evtMonth to month of evtStart as integer
        set evtDay to day of evtStart
        set evtWeekday to weekday of evtStart as string
        set dateStr to text 1 thru 3 of evtWeekday & \" \" & evtMonth & \"/\" & evtDay
        set startHour to hours of evtStart
        set startMin to minutes of evtStart
        set endHour to hours of evtEnd
        set endMin to minutes of evtEnd
        set startStr to text -2 thru -1 of (\"0\" & startHour) & \":\" & text -2 thru -1 of (\"0\" & startMin)
        set endStr to text -2 thru -1 of (\"0\" & endHour) & \":\" & text -2 thru -1 of (\"0\" & endMin)
        set line_ to dateStr & \" | \" & startStr & \"-\" & endStr & \" -- \" & evtName & \" [$cal]\"
        if evtLoc is not \"\" and evtLoc is not missing value then
          set line_ to line_ & \" @ \" & evtLoc
        end if
        set output to output & line_ & linefeed
      end try
    end repeat
  end try
  return output
end tell" 2>/dev/null
  ) &
done

# Wait for all with a 30s overall timeout
WAIT_PID=$$
(sleep 30 && kill -TERM $WAIT_PID 2>/dev/null) &
TIMER_PID=$!

wait $(jobs -p | grep -v $TIMER_PID) 2>/dev/null
kill $TIMER_PID 2>/dev/null
