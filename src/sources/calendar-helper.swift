import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)

store.requestFullAccessToEvents { granted, error in
    guard granted else {
        print("(calendar access denied)")
        semaphore.signal()
        return
    }

    let cal = Calendar.current
    let startOfDay = cal.startOfDay(for: Date())
    let endOfDay = cal.date(byAdding: .day, value: 1, to: startOfDay)!

    let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
    let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }

    if events.isEmpty {
        print("(no events today)")
    } else {
        let fmt = DateFormatter()
        fmt.dateFormat = "h:mm a"

        for event in events {
            let start = fmt.string(from: event.startDate)
            let end = fmt.string(from: event.endDate)
            var line = "\(start)–\(end) — \(event.title ?? "Untitled")"
            if let loc = event.location, !loc.isEmpty {
                line += " @ \(loc)"
            }
            print(line)
        }
    }

    semaphore.signal()
}

semaphore.wait()
