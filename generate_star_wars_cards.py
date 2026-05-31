import os
from PIL import Image, ImageDraw, ImageFont

# Boyutlar ve Klasörler
CARD_WIDTH = 250
CARD_HEIGHT = 350
OUTPUT_DIR = "public/img"
ASSETS_DIR = "assets"  # Eğer kullanıcı karakter resimlerini eklemek isterse bu klasörü kullanacak

# Renkler
COLOR_DARK = (20, 20, 25)
COLOR_LIGHT = (240, 240, 245)
COLOR_RED = (220, 40, 40)
COLOR_BLACK = (30, 30, 30)
COLOR_GOLD = (210, 180, 50)
COLOR_EMPIRE = (80, 20, 20)
COLOR_REBEL = (20, 60, 100)

if not os.path.exists(OUTPUT_DIR):
    os.makedirs(OUTPUT_DIR)

if not os.path.exists(ASSETS_DIR):
    os.makedirs(ASSETS_DIR)

# Tema Eşleştirmeleri
theme_mapping = {
    'K': {'hearts': 'Luke Skywalker', 'diamonds': 'Yoda', 'spades': 'Darth Vader', 'clubs': 'Palpatine'},
    'Q': {'hearts': 'Prenses Leia', 'diamonds': 'Padme', 'spades': 'Rey', 'clubs': 'Ahsoka Tano'},
    'J': {'hearts': 'Han Solo', 'diamonds': 'Chewbacca', 'spades': 'Boba Fett', 'clubs': 'Kylo Ren'},
    'A': {'hearts': 'X-Wing', 'diamonds': 'Millennium Falcon', 'spades': 'Death Star', 'clubs': 'Tie Fighter'}
}

suits = {
    'hearts': {'symbol': '♥', 'color': COLOR_RED, 'side': 'light'},
    'diamonds': {'symbol': '♦', 'color': COLOR_RED, 'side': 'light'},
    'spades': {'symbol': '♠', 'color': COLOR_BLACK, 'side': 'dark'},
    'clubs': {'symbol': '♣', 'color': COLOR_BLACK, 'side': 'dark'}
}

values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

try:
    # Font ayarlamaya çalış (varsayılan işletim sistemi fontlarından biri)
    # Eğer font bulunamazsa varsayılanı kullanacak
    font_large = ImageFont.truetype("arialbd.ttf", 36)
    font_small = ImageFont.truetype("arial.ttf", 24)
    font_center = ImageFont.truetype("arialbd.ttf", 22)
except IOError:
    font_large = ImageFont.load_default()
    font_small = ImageFont.load_default()
    font_center = ImageFont.load_default()

def draw_card(suit, value):
    side = suits[suit]['side']
    symbol = suits[suit]['symbol']
    color = suits[suit]['color']
    
    # Arka plan rengi
    bg_color = COLOR_REBEL if side == 'light' else COLOR_EMPIRE
    
    img = Image.new('RGB', (CARD_WIDTH, CARD_HEIGHT), COLOR_LIGHT)
    draw = ImageDraw.Draw(img)
    
    # İç çerçeve / Zemin
    margin = 15
    draw.rectangle([margin, margin, CARD_WIDTH-margin, CARD_HEIGHT-margin], fill=bg_color, outline=COLOR_GOLD, width=3)
    
    # Sol Üst ve Sağ Alt Köşedeki Değerler
    text_color = COLOR_LIGHT
    
    # Sol üst
    draw.text((margin + 10, margin + 10), value, font=font_large, fill=text_color)
    draw.text((margin + 10, margin + 45), symbol, font=font_large, fill=color)
    
    # Merkez Yazısı veya Görsel
    center_text = ""
    if value in theme_mapping:
        center_text = theme_mapping[value][suit]
    else:
        # Sayı kartları
        if side == 'light':
            center_text = f"Light Side\n({value})"
        else:
            center_text = f"Dark Side\n({value})"

    # Ortaya metin yazdır (veya resmi yapıştır)
    # Eğer kullanıcının assets klasöründe resim varsa onu yapıştırabilir
    asset_path = os.path.join(ASSETS_DIR, f"{center_text}.png")
    if os.path.exists(asset_path):
        try:
            asset_img = Image.open(asset_path).convert("RGBA")
            asset_img = asset_img.resize((150, 150))
            img.paste(asset_img, (50, 100), asset_img)
        except Exception as e:
            print(f"Resim yüklenemedi: {asset_path} - {e}")
            draw_center_text(draw, center_text, text_color)
    else:
        draw_center_text(draw, center_text, text_color)

    # Resmi Kaydet
    output_path = os.path.join(OUTPUT_DIR, f"{suit}_{value}.png")
    img.save(output_path)
    print(f"Oluşturuldu: {output_path}")

def draw_center_text(draw, text, color):
    # Metni ortalamak için
    lines = text.split('\n')
    y_offset = CARD_HEIGHT // 2 - (len(lines) * 15)
    for line in lines:
        try:
            # bbox kullanımı PIL sürümüne bağlı olarak değişebilir
            bbox = font_center.getbbox(line)
            w = bbox[2] - bbox[0]
        except AttributeError:
            w = len(line) * 12 # Tahmini genişlik
        
        draw.text(((CARD_WIDTH - w) // 2, y_offset), line, font=font_center, fill=color)
        y_offset += 30

print("Star Wars Destesi Üretiliyor...")
for suit in suits.keys():
    for val in values:
        draw_card(suit, val)

print("Tüm kartlar başarıyla oluşturuldu!")
