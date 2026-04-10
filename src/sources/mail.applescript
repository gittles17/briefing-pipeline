tell application "Mail"
	set cutoff to (current date) - 24 * hours
	set output to ""

	-- Get inbox messages
	try
		set msgs to (every message of inbox whose date received is greater than cutoff)
		repeat with msg in msgs
			try
				set s to sender of msg
				set subj to subject of msg
				set acctName to name of account of mailbox of msg
				set output to output & "[" & acctName & "] From: " & s & " — " & subj & linefeed
			end try
		end repeat
	end try

	-- Get trash/deleted messages from each account
	repeat with acct in every account
		set acctName to name of acct
		repeat with mb in every mailbox of acct
			try
				set mbName to name of mb
				if mbName is "Deleted Messages" or mbName is "Deleted Items" or mbName is "Trash" or mbName is "Archive" or mbName is "All Mail" then
					set msgs to (every message of mb whose date received is greater than cutoff)
					repeat with msg in msgs
						try
							set s to sender of msg
							set subj to subject of msg
							set output to output & "[" & acctName & " / " & mbName & "] From: " & s & " — " & subj & linefeed
						end try
					end repeat
				end if
			end try
		end repeat
	end repeat

	return output
end tell
