FROM node:24-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/app/data/facility_catalog.json /build/backend/app/data/facility_catalog.json
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./backend/app
COPY --from=frontend-build /build/frontend/public/data/osm-ideas.json ./backend/data/fallback_dataset.json
COPY --from=frontend-build /build/frontend/public/data/osm-places.json ./backend/data/public_places.json
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
ENV PYTHONPATH=/app/backend
ENV PORT=8080
ENV PLACE_SEARCH_PROVIDER=public_catalog
ENV TRAVEL_DATABASE_PATH=/tmp/conciergo/travel.sqlite3
ENV DISCOVERY_REVIEW_DB_PATH=/tmp/conciergo/journey_reviews.sqlite3
ENV GOOGLE_PHOTO_QUOTA_PATH=/tmp/conciergo/google_photo_quota.sqlite3
ENV OSM_RESTAURANTS_CACHE_PATH=/tmp/conciergo/osm_restaurants.sqlite3
ENV PYTHON_DOTENV_DISABLED=1
RUN useradd --uid 10001 --create-home appuser
USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
