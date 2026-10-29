"""
Deye Cloud API Client
Обертка для работы с Deye Cloud API для получения данных инвертора
"""

import requests
import logging

logger = logging.getLogger(__name__)


class DeyeCloudAPI:
    """Клиент для работы с Deye Cloud API"""

    BASE_URL = "https://eu1.deyecloud.com"

    def __init__(self, token, station_id):
        """
        Инициализация API клиента

        Args:
            token: Bearer token для авторизации
            station_id: ID станции (инвертора) в Deye Cloud
        """
        self.token = token
        self.station_id = station_id
        self.headers = {
            "Authorization": f"bearer {token}",
            "system": "Deye",
            "platform": "web",
            "version": "4.9.0",
            "language": "en"
        }

    def get_station_display(self):
        """
        Получить текущие данные станции.

        Returns:
            dict с полями:
                - batterySoc: float (%)
                - batteryPower: float (Вт, + = разряд, - = зарядка)
                - batteryStatus: str (DISCHARGE | CHARGE | STATIC)
                - batteryBv: float (вольт)
                - gridRelayStatus: str (on | off)
                - wirePower: float (Вт из сети)
                - usePower: float (Вт потребление)
                - generationPower: float (Вт генерация)
                - lastUpdateTime: float (Unix timestamp)
                - networkStatus: str (NORMAL | ...)

        Raises:
            requests.exceptions.RequestException: При ошибке запроса
        """
        try:
            response = requests.get(
                f"{self.BASE_URL}/maintain-s/station/display",
                params={"stationId": self.station_id},
                headers=self.headers,
                timeout=10
            )
            response.raise_for_status()
            data = response.json()
            logger.info(f"Successfully fetched data from Deye Cloud (SOC: {data.get('batterySoc')}%)")
            return data
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to fetch data from Deye Cloud: {e}")
            raise

    def calculate_status_code(self, data):
        """
        Рассчитать код статуса на основе данных (логика как в ESP32).

        Args:
            data: dict с данными от API

        Returns:
            int (0-4):
                - 0: Нет сети
                - 1: Сеть
                - 2: Зарядка
                - 3: Батарея (разряд)
                - 4: Критический разряд
        """
        grid_on = data.get('gridRelayStatus') == 'on'
        battery_power = data.get('batteryPower', 0)
        battery_soc = data.get('batterySoc', 0)
        wire_power = data.get('wirePower', 0)

        # Нет сети
        if not grid_on or wire_power == 0:
            return 0

        # Зарядка (отрицательное значение)
        if battery_power < -100:
            return 2

        # Разряд батареи
        if battery_power > 500:
            if battery_soc >= 35:
                return 3  # Нормальный разряд
            else:
                return 4  # Критический разряд

        # Сеть (нормальный режим)
        return 1
