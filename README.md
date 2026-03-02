# CCTV Management Server

Backend server for the CCTV Management System, built with Node.js, Express, and Sequelize.

## Features

- Camera Management (Create, Read, Update, Delete, Toggle Status)
- Bulk Upload Cameras via Excel
- RTSP Stream Proxying
- Keycloak Integration for Authentication
- College/Entity Management

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **ORM:** Sequelize (MySQL/MariaDB)
- **Authentication:** Keycloak / JWT
- **Media:** FFmpeg / RTSP-to-WS

## Prerequisites

- Node.js (v16+)
- MySQL/MariaDB Server
- FFmpeg installed on the system

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd cctv-server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and fill in your details:
   ```bash
   cp .env.example .env
   ```

4. **Run the server:**
   - Development mode:
     ```bash
     npm run dev
     ```
   - Production mode:
     ```bash
     npm start
     ```

## API Documentation

The server runs on `http://localhost:3000` by default.

### Key Routes
- `POST /api/cameras` - Create a camera
- `GET /api/cameras` - List cameras
- `GET /api/cameras/template/download` - Download Excel template
- `POST /api/cameras/bulk-upload` - Upload camera data in bulk
- `POST /api/cameras/:id/start-stream` - Start RTSP stream proxy

## License

ISC
