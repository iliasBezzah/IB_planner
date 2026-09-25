# Walkthrough — Student Academic Dashboard Refactoring & High-Utility Academic Tools

We have completely refactored the student dashboard by removing the unused lifestyle trackers and implementing a comprehensive suite of academic productivity tools, simulators, and synchronized workflows.

---

## 1. What Was Removed (Part 1: Screen Space Reclamation)
- **Mood & Energy**: Removed the emoji selector rows (`#moodMorningRow`, `#moodEveningRow`) and energy/focus range slider (`#energySlider`).
- **Daily Tracker**: Removed water glasses, meals, sport minutes, and sleep counters (`.panel-health`).
- **Academic Day Progress Bar & Redundant Metrics**: Removed `.day-progress-bar`, `stat-done`, `stat-priority`, `stat-breaks`, and `stat-progress`, replacing them with an academic summary bar.
- **Inline Quick Add Panel**: Removed the vertical-heavy `.panel-quick` inline form from the right column. Quick scheduling remains accessible via the clean **"+ Add Event"** modal button.

---

## 2. Core Academic Dashboard Replacements (Part 2)

### 1. "Next Up" Banner & Urgent Deadline Card
- **Location**: Prominently pinned at the top of the dashboard above the timetable.
- **"Next Up" Class Card**:
  - Dynamically detects the immediate next scheduled lecture today (e.g. `Biology HL (in 45 mins) • 10:00 – 11:30 • Lab 2`).
  - If a lecture is currently in progress, it shows `● ONGOING: [Class Title]`.
  - If all classes for the day have finished, it displays `✨ All lectures completed for today!`.
  - Clicking the card opens that course's details hub.
- **"Closest Deadline" Card**:
  - Automatically scans assignments across all active courses and identifies the single closest incomplete deadline.
  - Displays due date, due time, course name, and a real-time countdown pill (`⚠️ Due Today (6h left)`, `⏳ Due in 3 days`, or `🚨 Overdue`).
  - Clicking the card navigates directly to that assignment in the Course Hub.
- **Academic Summary Bar**:
  - Displays: **Study Logged Today**, **Lectures Today**, **Pending Tasks**, and **Pomodoro Focus Time**.

### 2. Study Focus Timer (Pomodoro)
- **Embedded Widget**: Positioned in the right column (`#pomodoroWidget`).
- **Presets**: 25 min Focus, 5 min Short Break, and 15 min Long Rest presets.
- **Subject / Course Selector**: `<select id="pomoCourseSelect">` allows students to select the specific course they are studying for.
- **Automatic Study Hours Logging**: When a 25-minute focus session completes:
  - An audio chime sounds and a notification toast appears.
  - A completed study block is automatically recorded in today's timetable associated with that course (`cat: 'study'`).
  - Study hours for that course immediately update across the dashboard and Study Analytics.

### 3. Quick Scratchpad
- **Embedded Notepad**: Located in the right column (`#scratchpadWidget`).
- **Auto-Saving**: Any thoughts, equations, or scratch notes typed into `#scratchpadInput` are debounced and automatically persisted to `localStorage` with a green `✓ Saved` status badge.
- **Actions**: Includes 1-click **Copy** (to clipboard) and **Clear** buttons.

---

## 3. High-Utility Academic Features (Part 3)

### 1. GPA & Course Grade Simulator (Student View)
- **5th Tab in Course Hub**: Added **"Grade Simulator"** tab (`#cdPanelGrades`) inside `courseDetailsModal`.
- **Assessment Components**:
  - Students can define and track weighted components (e.g. Midterm 30%, Lab Reports 30%, Final Exam 40%).
  - Automatically computes **Current Weighted Average** and maps it to the **IB 1–7 scale** (or Letter Grade equivalent).
- **Final Exam Target Simulator**:
  - Students select a target goal (IB 7: 85%, IB 6: 75%, IB 5: 65%, or IB 4: 50% Pass).
  - The simulator automatically calculates the **exact minimum percentage score required on the remaining/Final Exam** to secure that grade.
  - Realistic alerts:
    - If required score $\le 100\%$: `🎯 Final Exam Target: 78.4% Required`.
    - If required score $> 100\%$: `⚠️ Target IB 7 Out of Reach (requires 108.5%). Highest attainable score is 6.`
    - If already secured: `🎉 Target Secured! Even with 0% on remaining assessments, your score will meet the threshold.`

### 2. Assignment Deliverable Submissions (Student & Instructor Sync)
- **Student View**:
  - Inside Course Details -> Assignments, students can click **"Submit Deliverable"**.
  - Opens `#submitAssignmentModal` where students paste deliverable URLs (Google Drive, GitHub, Figma, Notion) and optional comments.
  - Marks assignment completed and displays a clickable deliverable pill (`🔗 Deliverable Link`).
  - Syncs deliverable metadata to Firestore under `classrooms/{classCode}/submissions/{assignmentId}_{studentUid}`.
- **Instructor View**:
  - On instructor assignment cards, clicking **"View Submissions"** opens `#assignmentSubmissionsModal`.
  - Displays a live roster table with student names, submission timestamps, clickable links to student work, and notes.

### 3. Exam Countdown & Focused Revision Blocks
- **Upcoming Exams Widget**: Positioned in the right column (`#upcomingExamsWidget`).
- Automatically scans upcoming timetable events and assignments for exam categories or keywords (Midterm, Final, Test, Quiz).
- Displays countdown badges (`In 4 days`, `Tomorrow!`, `Today!`).
- **1-Click "Revise" Button**: Automatically schedules a 2-hour focused revision block in the student's timetable for that course.

### 4. Google Calendar / iCal Export (.ics)
- **1-Click Export**: Added **"Export (.ics)"** button in the top navigation bar and User Profile dropdown.
- Generates an RFC 5545 standard `.ics` calendar file containing recurring classes with recurrence rules (`RRULE:FREQ=WEEKLY;BYDAY=...`), timetable events, and assignment due dates.
- Downloads `IB_Academic_Schedule.ics` ready to import into Google Calendar, Apple Calendar, or Outlook.

---

## 4. Verification & Validation Results

1. **Syntax Check**:
   - `node -c app.js` — **Passed (0 errors)**.
   - `node -c sw.js` — **Passed (0 errors)**.
2. **PWA Cache Version**:
   - Bumped to `v15` across `index.html` (`style.css?v=15`, `firebase-config.js?v=15`, `app.js?v=15`) and `sw.js` (`ib-planner-v15`).
3. **Desktop Synchronization**:
   - All files (`app.js`, `index.html`, `style.css`, `sw.js`, `walkthrough.md`) mirrored directly to `C:\Users\Lenovo\Desktop\IB-Planner\`.
