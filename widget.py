"""
Deye Inverter Monitor Widget
Premium glass dashboard
"""

import tkinter as tk
from tkinter import Canvas
import configparser
import logging
import os
import sys
import math
from datetime import datetime
from PIL import Image, ImageDraw, ImageTk
import pystray
from threading import Thread
from deye_api import DeyeCloudAPI


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('deye_widget.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


class GlassWidget:
    """Premium glass dashboard widget"""

    # Glass UI palette
    BG = "#0d1117"
    TEXT_PRIMARY = "#f0f3f6"
    TEXT_SECONDARY = "#8b949e"
    GLASS_BORDER = "#30363d"

    # Status colors
    STATUS_COLORS = {
        0: "#ff5b66",  # Red - no grid
        1: "#27df91",  # Green - grid
        2: "#ffb52e",  # Amber - charging
        3: "#38a7ff",  # Blue - battery
        4: "#ff5b66"   # Red - critical
    }

    STATUS_TEXTS = {
        0: "NO GRID",
        1: "GRID ONLINE",
        2: "CHARGING",
        3: "ON BATTERY",
        4: "CRITICAL"
    }

    def __init__(self):
        self.root = tk.Tk()

        # Always on top
        self.root.attributes('-topmost', True)

        # Убрать рамку
        self.root.overrideredirect(True)

        # Размер
        self.root.geometry("300x235")
        self.root.attributes('-alpha', 0.92)

        # Для перетаскивания
        self._drag_x = 0
        self._drag_y = 0

        # Конфиг
        self.load_config()

        # API
        self.api = DeyeCloudAPI(
            token=self.config['Deye']['token'],
            station_id=self.config['Deye']['station_id']
        )

        self.refresh_interval = int(self.config['Widget']['refresh_interval']) * 1000
        self.sound_grid_lost = self.config['Sounds'].get('grid_lost', 'sounds/grid_lost.wav')
        self.sound_grid_back = self.config['Sounds'].get('grid_back', 'sounds/grid_back.wav')
        self.last_grid_status = None

        # Tray
        self.setup_tray()

        # UI
        self.create_ui()

        # Первое обновление
        self.root.after(1000, self.update_data)

        logger.info("Glass Widget started")

    def load_config(self):
        self.config = configparser.ConfigParser()
        if not os.path.exists('config.ini'):
            sys.exit(1)
        self.config.read('config.ini', encoding='utf-8')

    def setup_tray(self):
        """Настроить system tray с рабочим меню"""
        # Иконка
        img = Image.new('RGB', (64, 64), '#0d1117')
        draw = ImageDraw.Draw(img)
        draw.ellipse([12, 12, 52, 52], fill='#27df91')

        # Меню
        def on_show():
            self.root.deiconify()
            self.root.lift()
            self.root.attributes('-topmost', True)

        def on_exit():
            self.tray_icon.stop()
            self.root.quit()

        menu = pystray.Menu(
            pystray.MenuItem("Show Widget", on_show, default=True),
            pystray.MenuItem("Exit", on_exit)
        )

        self.tray_icon = pystray.Icon("deye", img, "Deye Monitor", menu)
        Thread(target=self.tray_icon.run, daemon=True).start()

    def create_ui(self):
        """Создать UI как в референсе"""

        # Главный canvas для glass эффекта
        main = Canvas(
            self.root,
            width=300,
            height=235,
            bg=self.BG,
            highlightthickness=0
        )
        main.pack(fill=tk.BOTH, expand=True)

        # Bind для перетаскивания
        main.bind('<Button-1>', self.start_drag)
        main.bind('<B1-Motion>', self.do_drag)

        # Рисуем glass panel
        self.draw_glass_panel(main)

        # === TOP BAR ===
        # Status dot
        self.status_dot_id = main.create_oval(18, 15, 26, 23, fill="#27df91", outline="")

        # Status text
        self.status_text_id = main.create_text(
            32, 19,
            text="CHARGING",
            font=("Segoe UI", 9),
            fill="#27df91",
            anchor="w"
        )

        # Time
        self.time_text_id = main.create_text(
            280, 19,
            text="23:17",
            font=("Segoe UI", 9),
            fill=self.TEXT_SECONDARY,
            anchor="e"
        )

        # === BATTERY CIRCLE ===
        cx, cy = 80, 135

        # Track circle (тёмно-серый)
        main.create_oval(
            cx-42, cy-42, cx+42, cy+42,
            outline="#1f2428",
            width=4
        )

        # Progress arc (будем обновлять)
        self.progress_arc_id = self.draw_arc_segment(main, cx, cy, 42, 0, 270, "#27df91", 4)

        # Battery percent
        self.battery_text_id = main.create_text(
            cx, cy,
            text="92%",
            font=("Segoe UI", 32, "bold"),
            fill=self.TEXT_PRIMARY
        )

        # === METRICS (справа от круга) ===
        mx = 150
        my = 75

        # Battery
        self.battery_icon_id = main.create_text(mx, my, text="🔋", font=("Segoe UI", 16), fill=self.TEXT_SECONDARY)
        self.battery_value_id = main.create_text(
            mx+20, my,
            text="-3.10 kW",
            font=("Segoe UI", 12, "bold"),
            fill=self.TEXT_PRIMARY,
            anchor="w"
        )
        self.battery_emoji_id = main.create_text(mx+95, my, text="⚡", font=("Segoe UI", 14), fill="#27df91")

        # Grid
        my += 35
        self.grid_icon_id = main.create_text(mx, my, text="🗼", font=("Segoe UI", 16), fill=self.TEXT_SECONDARY)
        self.grid_value_id = main.create_text(
            mx+20, my,
            text="3.75 kW",
            font=("Segoe UI", 12, "bold"),
            fill=self.TEXT_PRIMARY,
            anchor="w"
        )

        # Load
        my += 35
        self.load_icon_id = main.create_text(mx, my, text="🏠", font=("Segoe UI", 16), fill=self.TEXT_SECONDARY)
        self.load_value_id = main.create_text(
            mx+20, my,
            text="0.49 kW",
            font=("Segoe UI", 12, "bold"),
            fill=self.TEXT_PRIMARY,
            anchor="w"
        )

        # Сохранить canvas
        self.canvas = main

    def draw_glass_panel(self, canvas):
        """Нарисовать glass panel с закруглением"""
        w, h = 300, 235
        r = 16  # radius

        # Фон с закруглением
        # Используем прямоугольник с эмуляцией закругления через несколько shape
        canvas.create_rectangle(r, 0, w-r, h, fill=self.BG, outline="")
        canvas.create_rectangle(0, r, w, h-r, fill=self.BG, outline="")

        # Углы
        canvas.create_arc(0, 0, r*2, r*2, start=90, extent=90, fill=self.BG, outline="")
        canvas.create_arc(w-r*2, 0, w, r*2, start=0, extent=90, fill=self.BG, outline="")
        canvas.create_arc(0, h-r*2, r*2, h, start=180, extent=90, fill=self.BG, outline="")
        canvas.create_arc(w-r*2, h-r*2, w, h-r*2, start=270, extent=90, fill=self.BG, outline="")

        # Тонкая светлая рамка
        border_color = self.GLASS_BORDER

        # Верх
        canvas.create_line(r, 0, w-r, 0, fill=border_color, width=1)
        # Право
        canvas.create_line(w, r, w, h-r, fill=border_color, width=1)
        # Низ
        canvas.create_line(r, h, w-r, h, fill=border_color, width=1)
        # Лево
        canvas.create_line(0, r, 0, h-r, fill=border_color, width=1)

        # Углы (дуги)
        canvas.create_arc(0, 0, r*2, r*2, start=90, extent=90, outline=border_color, style="arc", width=1)
        canvas.create_arc(w-r*2, 0, w, r*2, start=0, extent=90, outline=border_color, style="arc", width=1)
        canvas.create_arc(0, h-r*2, r*2, h, start=180, extent=90, outline=border_color, style="arc", width=1)
        canvas.create_arc(w-r*2, h-r*2, w, h-r*2, start=270, extent=90, outline=border_color, style="arc", width=1)

    def draw_arc_segment(self, canvas, cx, cy, radius, start_angle, extent, color, width):
        """Нарисовать дугу прогресса"""
        bbox = (cx-radius, cy-radius, cx+radius, cy+radius)
        return canvas.create_arc(
            *bbox,
            start=start_angle-90,  # Начать сверху
            extent=extent,
            outline=color,
            width=width,
            style="arc"
        )

    def start_drag(self, e):
        self._drag_x = e.x
        self._drag_y = e.y

    def do_drag(self, e):
        x = self.root.winfo_pointerx() - self._drag_x
        y = self.root.winfo_pointery() - self._drag_y
        self.root.geometry(f'+{x}+{y}')

    def play_sound(self, file):
        try:
            if os.path.exists(file):
                import winsound
                winsound.PlaySound(file, winsound.SND_FILENAME | winsound.SND_ASYNC)
        except:
            pass

    def update_data(self):
        """Обновить данные"""
        try:
            data = self.api.get_station_display()
            status_code = self.api.calculate_status_code(data)

            # Цвет статуса
            color = self.STATUS_COLORS[status_code]
            status_text = self.STATUS_TEXTS[status_code]

            # Обновить статус
            self.canvas.itemconfig(self.status_dot_id, fill=color)
            self.canvas.itemconfig(self.status_text_id, text=status_text, fill=color)

            # Время
            self.canvas.itemconfig(self.time_text_id, text=datetime.now().strftime("%H:%M"))

            # Батарея
            soc = int(data.get('batterySoc', 0))
            self.canvas.itemconfig(self.battery_text_id, text=f"{soc}%")

            # Обновить circular progress
            self.canvas.delete(self.progress_arc_id)
            cx, cy = 80, 135
            extent = (soc / 100) * 360
            self.progress_arc_id = self.draw_arc_segment(self.canvas, cx, cy, 42, 0, extent, color, 4)

            # Метрики
            bat_power = data.get('batteryPower', 0) / 1000
            grid_power = data.get('wirePower', 0) / 1000
            load_power = data.get('usePower', 0) / 1000

            bat_sign = "⚡" if bat_power < 0 else "⏻"
            bat_emoji_color = color if bat_power < 0 else self.TEXT_SECONDARY

            self.canvas.itemconfig(self.battery_value_id, text=f"{bat_power:+.2f} kW")
            self.canvas.itemconfig(self.battery_emoji_id, text=bat_sign, fill=bat_emoji_color)
            self.canvas.itemconfig(self.grid_value_id, text=f"{grid_power:.2f} kW")
            self.canvas.itemconfig(self.load_value_id, text=f"{load_power:.2f} kW")

            # Звуки
            current_grid = data.get('gridRelayStatus') == 'on'
            if self.last_grid_status is not None:
                if self.last_grid_status and not current_grid:
                    logger.warning("GRID LOST!")
                    self.play_sound(self.sound_grid_lost)
                elif not self.last_grid_status and current_grid:
                    logger.info("GRID BACK!")
                    self.play_sound(self.sound_grid_back)
            self.last_grid_status = current_grid

        except Exception as e:
            logger.error(f"Error: {e}")
            self.canvas.itemconfig(self.status_text_id, text="OFFLINE", fill="#ff5b66")

        self.root.after(self.refresh_interval, self.update_data)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    try:
        app = GlassWidget()
        app.run()
    except Exception as e:
        logger.error(f"Fatal: {e}", exc_info=True)
        sys.exit(1)
