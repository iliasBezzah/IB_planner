# Gradia — Academic Workspace & Collaboration Hub

<p align="center">
  <img src="logo-mark.png" alt="Gradia Logo" width="120" height="120"/>
</p>

<p align="center">
  <b>A modern, cloud-synchronized academic management platform designed for higher education, students, and educators.</b>
</p>

---

## ✨ Features

- 📅 **Dynamic Academic Timetable**: Daily, weekly, monthly, and interactive timeline views with automated recurring schedule generation.
- 🎓 **Role-Based Hubs**:
  - **Student View**: Interactive lecture tracking, closest deadline urgency cards, focus timers, assignment submissions, and public course notes.
  - **Instructor View**: Course creation, assignment scheduling (drafts & published release dates), submissions review roster, and course management.
- ⏱️ **Study Focus Timer (Pomodoro)**: 25/5/15 minute presets with automatic course study-hour logging and analytics integration.
- 📊 **GPA & Grade Simulator**: Calculate course weighted components and simulate required final exam scores to achieve target grade thresholds.
- 📝 **Collaborative Notes & Chat**: Course-level public notes repository and real-time class communication with rich link chips.
- 🗓️ **iCal (.ics) Calendar Export**: One-click schedule sync with Google Calendar, Apple Calendar, and Outlook.
- 📱 **Progressive Web App (PWA)**: Full offline support via Service Worker, installable on Android, iOS, Windows, and macOS.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3 (Modern Slate & Indigo Design System)
- **Backend / Realtime Database**: Firebase Cloud Firestore (Spark Free Plan compatible)
- **Authentication**: Firebase Auth (Email & Username accounts)
- **PWA**: Service Worker (`Cache-First` offline caching), Web App Manifest

---

## 🚀 Getting Started

1. Clone or download the repository.
2. Open `index.html` in your web browser, or serve using any static web server:
   ```bash
   npx serve .
   ```
3. Deploy to **GitHub Pages** by going to **Settings ➔ Pages ➔ Deploy from branch: `main`**.
