from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from render import register_render

app = FastAPI(title="AnImation API")

# Allow the Vite dev server to call this API during local development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# T3: Manim render pipeline -- mounts /media and registers POST /api/render.
register_render(app)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/hello")
def hello() -> dict[str, str]:
    return {"message": "Hello from the AnImation Python backend!"}
