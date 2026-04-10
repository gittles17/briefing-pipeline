set today to current date
set time of today to 0
set endDate to today + 259200
set output to ""
tell application "Calendar"
	set calList to {"AJ Personal", "Untitled", "Calendar", "jonathan.gitlin@glossi.io", "gitlin.jonathan@gmail.com", "Family"}
	repeat with calName in calList
		try
			set cal to calendar calName
			set evts to (every event of cal whose start date ≥ today and start date < endDate)
			repeat with evt in evts
				try
					set evtStart to start date of evt
					set evtEnd to end date of evt
					set evtName to summary of evt
					set evtLoc to ""
					try
						set evtLoc to location of evt
					end try
					set evtMonth to month of evtStart as integer
					set evtDay to day of evtStart
					set evtWeekday to weekday of evtStart as string
					set dateStr to text 1 thru 3 of evtWeekday & " " & evtMonth & "/" & evtDay
					set startHour to hours of evtStart
					set startMin to minutes of evtStart
					set endHour to hours of evtEnd
					set endMin to minutes of evtEnd
					set startStr to text -2 thru -1 of ("0" & startHour) & ":" & text -2 thru -1 of ("0" & startMin)
					set endStr to text -2 thru -1 of ("0" & endHour) & ":" & text -2 thru -1 of ("0" & endMin)
					set line_ to dateStr & " | " & startStr & "-" & endStr & " -- " & evtName & " [" & calName & "]"
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
