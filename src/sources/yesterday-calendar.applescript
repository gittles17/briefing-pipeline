-- Fetch yesterday's calendar events for follow-up context
set yesterday to (current date) - (1 * days)
set todayStart to current date
set time of todayStart to 0

set output to ""
tell application "Calendar"
	set calList to {"AJ Personal", "Untitled", "Calendar", "jonathan.gitlin@glossi.io", "gitlin.jonathan@gmail.com", "Family"}
	repeat with calName in calList
		try
			set cal to calendar calName
			set evts to (every event of cal whose start date ≥ yesterday and start date < todayStart)
			repeat with evt in evts
				try
					set evtStart to start date of evt
					set evtEnd to end date of evt
					set evtName to summary of evt
					set evtLoc to ""
					try
						set evtLoc to location of evt
					end try
					set startHour to hours of evtStart
					set startMin to minutes of evtStart
					set endHour to hours of evtEnd
					set endMin to minutes of evtEnd
					set startStr to text -2 thru -1 of ("0" & startHour) & ":" & text -2 thru -1 of ("0" & startMin)
					set endStr to text -2 thru -1 of ("0" & endHour) & ":" & text -2 thru -1 of ("0" & endMin)
					set line_ to startStr & "-" & endStr & " -- " & evtName & " [" & calName & "]"
					if evtLoc is not "" and evtLoc is not missing value then
						set line_ to line_ & " @ " & evtLoc
					end if
					set output to output & line_ & linefeed
				end try
			end repeat
		end try
	end repeat
end tell
return output
