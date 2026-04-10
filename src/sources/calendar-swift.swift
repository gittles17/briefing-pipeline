import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)

store.requestFullAccessToEvents { granted, error in
    if granted {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let end = cal.date(byAdding: .day, value: 3, to: start)!
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
        for event in events.sorted(by: { $0.startDate < $1.startDate }) {
            let df = DateFormatter()
            df.dateFormat = "EEE M/d | HH:mm"
            let dfEnd = DateFormatter()
            dfEnd.dateFormat = "HH:mm"
            let calName = event.calendar.title
            let loc = event.location ?? ""
            var line = df.string(from: event.startDate) + "-" + dfEnd.string(from: event.endDate) + " -- " + (event.title ?? "(no title)") + " [" + calName + "]"
            if !loc.isEmpty { line += " @ " + loc }
            print(line)
        }
    } else {
        print("(calendar access denied)")
    }
    semaphore.signal()
}
semaphore.wait()
