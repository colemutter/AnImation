"""Hand-written Manim sample scene for the T3 render-pipeline spike.

This is a *known-good*, human-authored scene (NOT AI-generated). It exercises
the full render path: a circle moves left -> right while the camera performs a
small pan/zoom. It deliberately avoids ``Tex``/``MathTex`` so no LaTeX toolchain
is required.

Render manually with:
    uv run manim -ql backend/samples/moving_circle.py MovingCircle
"""

from manim import (
    BLUE,
    LEFT,
    RIGHT,
    Circle,
    Create,
    MovingCameraScene,
)


class MovingCircle(MovingCameraScene):
    """A blue circle slides from left to right while the camera follows."""

    def construct(self) -> None:
        circle = Circle(radius=0.75, color=BLUE)
        circle.set_fill(BLUE, opacity=0.5)
        circle.move_to(4 * LEFT)

        # Draw the circle in.
        self.play(Create(circle), run_time=1)

        # Move the circle left -> right and pan the camera with it.
        self.play(
            circle.animate.move_to(4 * RIGHT),
            self.camera.frame.animate.move_to(2 * RIGHT).scale(0.9),
            run_time=2,
        )

        self.wait(0.5)
