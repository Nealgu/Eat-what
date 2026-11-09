from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
canvas = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((10, 10, 502, 502), radius=155, fill='#e7835e')
def cubic(points):
    a, b, c, d = points
    return [((1-t)**3*a[0]+3*(1-t)**2*t*b[0]+3*(1-t)*t*t*c[0]+t**3*d[0],
             (1-t)**3*a[1]+3*(1-t)**2*t*b[1]+3*(1-t)*t*t*c[1]+t**3*d[1]) for t in [i/40 for i in range(41)]]
outline = []
for points in [((112,342),(54,277),(165,111),(225,86)),((225,86),(246,73),(272,73),(293,86)),((293,86),(352,111),(457,277),(398,342)),((398,342),(345,420),(169,420),(112,342))]:
    outline += cubic(points)
draw.polygon(outline, fill='#fffdf4')
draw.rounded_rectangle((205,278,313,424), radius=23, fill='#42604c')
draw.ellipse((179,223,205,249), fill='#42604c')
draw.ellipse((309,223,335,249), fill='#42604c')
draw.arc((232,231,281,270), start=5, end=175, fill='#42604c', width=6)
canvas.save(root/'assets'/'app.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
canvas.resize((256,256), Image.Resampling.LANCZOS).save(root/'assets'/'app-icon.png')
print('Generated app.ico and app-icon.png')
