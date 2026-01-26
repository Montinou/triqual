import sys
from PIL import Image

image_path = sys.argv[1]
output_path = sys.argv[2]

print(f"Opening {image_path}")
img = Image.open(image_path)
img = img.convert("RGBA")

datas = img.getdata()
new_data = []

# Simple threshold for black background
threshold = 15 

for item in datas:
    # item is (r, g, b, a)
    if item[0] < threshold and item[1] < threshold and item[2] < threshold:
        new_data.append((0, 0, 0, 0))
    else:
        new_data.append(item)

img.putdata(new_data)
# Crop the main content
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

print(f"Saving to {output_path}")
img.save(output_path, "PNG")
print("Done")
