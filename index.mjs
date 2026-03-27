import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const COMPLETE_TODO_MODE = "COMPLETE_TODO_MODE";
const DELETE_TODO_MODE = "DELETE_TODO_MODE";
const WEATHER_API_TIMEOUT_MS = 10000;

const requiredEnvVars = ["TELEGRAM_TOKEN", "WEATHER_API_KEY"];
const missingEnvVars = requiredEnvVars.filter(
  (envVarName) => !process.env[envVarName]?.trim(),
);

if (missingEnvVars.length > 0) {
  console.error(
    `[startup] Missing required environment variables: ${missingEnvVars.join(", ")}`,
  );
  process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: false,
    params: {
      timeout: 10,
    },
  },
});

const usersState = {};
let isShuttingDown = false;

function logInfo(message) {
  console.info(`[${new Date().toISOString()}] ${message}`);
}

function logError(message, error) {
  console.error(`[${new Date().toISOString()}] ${message}`);

  if (error) {
    console.error(error);
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    WEATHER_API_TIMEOUT_MS,
  );

  try {
    return await fetch(url, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function createDefaultUserState() {
  return {
    todos: [],
    editMode: COMPLETE_TODO_MODE,
    awaitingCity: false,
    savedWeatherCity: null,
    reminderIntervalId: null,
    reminderIntervalMs: null,
  };
}

function getUserState(chatId) {
  if (!usersState[chatId]) {
    usersState[chatId] = createDefaultUserState();
  }

  return usersState[chatId];
}

function getWeatherEmojiByDescription(weatherDescription) {
  const normalizedDescription = weatherDescription.toLowerCase();

  if (normalizedDescription.includes("ясно")) {
    return "☀️";
  }

  if (
    normalizedDescription.includes("небольшая облачность") ||
    normalizedDescription.includes("переменная облачность")
  ) {
    return "🌤️";
  }

  if (
    normalizedDescription.includes("облачно") ||
    normalizedDescription.includes("пасмурно")
  ) {
    return "☁️";
  }

  if (
    normalizedDescription.includes("дожд") ||
    normalizedDescription.includes("ливень")
  ) {
    return "🌧️";
  }

  if (normalizedDescription.includes("гроза")) {
    return "⛈️";
  }

  if (
    normalizedDescription.includes("снег") ||
    normalizedDescription.includes("метель")
  ) {
    return "❄️";
  }

  if (
    normalizedDescription.includes("туман") ||
    normalizedDescription.includes("дымка")
  ) {
    return "🌫️";
  }

  return "🌍";
}

function getTemperatureEmoji(temperatureValue) {
  if (temperatureValue >= 30) {
    return "🥵";
  }

  if (temperatureValue >= 20) {
    return "😎";
  }

  if (temperatureValue >= 10) {
    return "🙂";
  }

  if (temperatureValue >= 0) {
    return "🧥";
  }

  return "🥶";
}

function formatCurrentWeatherMessage(weatherData) {
  const weatherEmoji = getWeatherEmojiByDescription(weatherData.description);
  const temperatureEmoji = getTemperatureEmoji(weatherData.temp);

  return (
    `${weatherEmoji} Погода в ${weatherData.city}\n\n` +
    `🌡️ Температура: ${weatherData.temp}°C ${temperatureEmoji}\n` +
    `🖐️ Ощущается как: ${weatherData.feels_like}°C\n` +
    `☁️ Состояние: ${weatherData.description}\n` +
    `💧 Влажность: ${weatherData.humidity}%\n` +
    `🌬️ Скорость ветра: ${weatherData.wind_speed} м/с`
  );
}

function formatWeeklyForecastLine(dayLabel, description, temperatureValue) {
  const weatherEmoji = getWeatherEmojiByDescription(description);
  const temperatureEmoji = getTemperatureEmoji(temperatureValue);

  return `${weatherEmoji} ${dayLabel}: ${description}, температура: ${temperatureValue}°C ${temperatureEmoji}`;
}

function getReminderLabel(reminderIntervalMs) {
  if (!reminderIntervalMs) {
    return "выкл";
  }

  const reminderLabelMap = {
    30000: "30 сек",
    [10 * 60 * 1000]: "10 мин",
    [20 * 60 * 1000]: "20 мин",
    [30 * 60 * 1000]: "30 мин",
    [45 * 60 * 1000]: "45 мин",
    [60 * 60 * 1000]: "1 час",
  };

  return reminderLabelMap[reminderIntervalMs] ?? "вкл";
}

async function getWeather(city) {
  try {
    const requestUrl = new URL(
      "https://api.openweathermap.org/data/2.5/weather",
    );
    requestUrl.search = new URLSearchParams({
      q: city,
      appid: WEATHER_API_KEY,
      units: "metric",
      lang: "ru",
    }).toString();

    const response = await fetchWithTimeout(requestUrl);
    const data = await response.json();

    if (!response.ok || data.cod !== 200) {
      if (String(data.cod) === "404") {
        return { type: "CITY_NOT_FOUND" };
      }

      return { type: "API_ERROR" };
    }

    return {
      type: "SUCCESS",
      data: {
        description: data.weather[0].description,
        temp: Math.round(data.main.temp),
        feels_like: Math.round(data.main.feels_like),
        humidity: data.main.humidity,
        wind_speed: data.wind.speed,
        city: data.name,
      },
    };
  } catch (error) {
    return { type: "NETWORK_ERROR" };
  }
}

async function getWeeklyWeather(city) {
  try {
    const requestUrl = new URL(
      "https://api.openweathermap.org/data/2.5/forecast",
    );
    requestUrl.search = new URLSearchParams({
      q: city,
      appid: WEATHER_API_KEY,
      units: "metric",
      lang: "ru",
    }).toString();

    const response = await fetchWithTimeout(requestUrl);
    const data = await response.json();

    if (!response.ok || String(data.cod) !== "200") {
      return { type: "API_ERROR" };
    }

    const daysSet = new Set();
    const forecastLines = [];

    for (const forecastEntry of data.list) {
      const entryDate = new Date(forecastEntry.dt * 1000);
      const dayLabel = entryDate.toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      if (!daysSet.has(dayLabel)) {
        daysSet.add(dayLabel);

        const roundedTemperature = Math.round(forecastEntry.main.temp);
        const weatherDescription = forecastEntry.weather[0].description;

        forecastLines.push(
          formatWeeklyForecastLine(
            dayLabel,
            weatherDescription,
            roundedTemperature,
          ),
        );
      }

      if (forecastLines.length === 7) {
        break;
      }
    }

    return {
      type: "SUCCESS",
      message:
        `📅 Прогноз погоды на неделю в городе ${city}\n\n` +
        `${forecastLines.join("\n")}`,
    };
  } catch (error) {
    return { type: "NETWORK_ERROR" };
  }
}

function buildTodosText(chatId) {
  const userState = getUserState(chatId);

  if (userState.todos.length === 0) {
    return "Список задач пуст 😈";
  }

  const todoLines = userState.todos.map((todo, index) => {
    const status = todo.isCompleted ? "✅" : "❌";
    return `${index + 1}. ${status} ${todo.text}`;
  });

  return `Задачи:\n${todoLines.join("\n")}`;
}

function buildTodosKeyboard(chatId) {
  const userState = getUserState(chatId);

  const todoButtons = userState.todos.map((todo, index) => ({
    text: todo.isCompleted ? `✅ ${todo.text}` : todo.text,
    callback_data: `todo_${index}`,
  }));

  const todoButtonRows = [];
  for (
    let buttonIndex = 0;
    buttonIndex < todoButtons.length;
    buttonIndex += 3
  ) {
    todoButtonRows.push(todoButtons.slice(buttonIndex, buttonIndex + 3));
  }

  const modeButtonRow = [
    {
      text:
        userState.editMode === COMPLETE_TODO_MODE
          ? "⚙️ Режим: Выполнение ✅"
          : "⚙️ Режим: Удаление 🗑️",
      callback_data: "toggle_mode",
    },
  ];

  const reminderButtonRow = [
    {
      text: `⏰ Напоминание: ${getReminderLabel(userState.reminderIntervalMs)}`,
      callback_data: "set_reminder",
    },
  ];

  const weatherButtonRow = [
    {
      text: "🌦️ Погода",
      callback_data: "show_weather",
    },
  ];

  return {
    inline_keyboard: [
      modeButtonRow,
      reminderButtonRow,
      weatherButtonRow,
      ...todoButtonRows,
    ],
  };
}

async function sendMessage(chatId, text, options) {
  return bot.sendMessage(chatId, text, options);
}

async function displayTodos(chatId) {
  await sendMessage(chatId, buildTodosText(chatId), {
    reply_markup: buildTodosKeyboard(chatId),
  });
}

async function stopReminder(chatId, shouldNotify = true) {
  const userState = getUserState(chatId);

  if (userState.reminderIntervalId) {
    clearInterval(userState.reminderIntervalId);
    userState.reminderIntervalId = null;
  }

  userState.reminderIntervalMs = null;

  if (shouldNotify) {
    await sendMessage(chatId, "🔕 Напоминания отключены.");
  }
}

async function setGlobalReminder(chatId, interval) {
  const userState = getUserState(chatId);

  if (userState.reminderIntervalId) {
    clearInterval(userState.reminderIntervalId);
  }

  userState.reminderIntervalMs = interval;

  userState.reminderIntervalId = setInterval(async () => {
    try {
      const latestUserState = getUserState(chatId);
      const incompleteTasks = latestUserState.todos.filter(
        (task) => !task.isCompleted,
      );

      if (latestUserState.todos.length === 0 || incompleteTasks.length === 0) {
        await sendMessage(
          chatId,
          "🎉 Ура, ты молодец, так продолжать, выполнил все задачи 😻",
        );
        await stopReminder(chatId, false);
        return;
      }

      await sendMessage(chatId, "🔔 Еще не выполнил все свои задачи 😡");
    } catch (error) {
      logError(`Failed to send reminder to chat ${chatId}`, error);
    }
  }, interval);

  await sendMessage(
    chatId,
    `🔔 Напоминания включены каждые ${getReminderLabel(interval)}.`,
  );
}

function getReminderIntervalFromCallback(callbackData) {
  const intervalMap = {
    remind_30sec: 30000,
    remind_10min: 10 * 60 * 1000,
    remind_20min: 20 * 60 * 1000,
    remind_30min: 30 * 60 * 1000,
    remind_45min: 45 * 60 * 1000,
    remind_1hour: 60 * 60 * 1000,
  };

  return intervalMap[callbackData] ?? null;
}

async function startWeatherQuery(
  chatId,
  message = "Укажи город, чтобы узнать погоду 🤔",
) {
  const userState = getUserState(chatId);
  userState.awaitingCity = true;
  await sendMessage(chatId, message);
}

async function showWeatherMenu(chatId) {
  const userState = getUserState(chatId);

  if (userState.savedWeatherCity) {
    await sendMessage(
      chatId,
      `Сохранён город: ${userState.savedWeatherCity}. Что показать?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Показать погоду: ${userState.savedWeatherCity}`,
                callback_data: "show_saved_weather",
              },
            ],
            [
              {
                text: "Выбрать другой город",
                callback_data: "change_weather_city",
              },
            ],
          ],
        },
      },
    );
    return;
  }

  await startWeatherQuery(chatId);
}

async function handleWeatherRequest(chatId, city) {
  const userState = getUserState(chatId);
  const normalizedCity = city.trim();

  if (!normalizedCity) {
    userState.awaitingCity = true;
    await sendMessage(chatId, "Нужен непустой город. Попробуй ещё раз.");
    return;
  }

  const weatherResult = await getWeather(normalizedCity);

  if (weatherResult.type === "CITY_NOT_FOUND") {
    await sendMessage(chatId, "Город не найден 😮 Попробуй снова");
    userState.awaitingCity = true;
    return;
  }

  if (
    weatherResult.type === "API_ERROR" ||
    weatherResult.type === "NETWORK_ERROR"
  ) {
    userState.awaitingCity = false;
    await sendMessage(
      chatId,
      "Упс, погода сейчас недоступна. Переключаю обратно в режим заметок.",
    );
    await displayTodos(chatId);
    return;
  }

  userState.awaitingCity = false;
  userState.savedWeatherCity = weatherResult.data.city;

  const weatherMessage = formatCurrentWeatherMessage(weatherResult.data);

  await sendMessage(chatId, weatherMessage, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Прогноз на неделю", callback_data: "weekly_weather" }],
        [
          {
            text: "Выбрать другой город",
            callback_data: "change_weather_city",
          },
        ],
      ],
    },
  });
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const userState = getUserState(chatId);

    userState.editMode = COMPLETE_TODO_MODE;
    userState.awaitingCity = false;

    await sendMessage(
      chatId,
      `Привет! Это бот помощник 🧞‍♂️
Добавляй задачи 🙈, устанавливай напоминания 🙉 и следи за погодой 💁‍♂️`,
    );

    await displayTodos(chatId);
  } catch (error) {
    logError(`Failed to process /start for chat ${chatId}`, error);
  }
});

bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message?.chat.id;
  const callbackData = callbackQuery.data;

  if (!chatId || !callbackData) {
    return;
  }

  const userState = getUserState(chatId);

  try {
    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
      logError("Failed to answer callback query", error);
    }

    if (callbackData.startsWith("todo_")) {
      const todoIndex = Number(callbackData.split("_")[1]);
      const selectedTodo = userState.todos[todoIndex];

      if (!selectedTodo) {
        await sendMessage(chatId, "Задача не найдена.");
        return;
      }

      if (userState.editMode === COMPLETE_TODO_MODE) {
        selectedTodo.isCompleted = !selectedTodo.isCompleted;
        await sendMessage(
          chatId,
          selectedTodo.isCompleted
            ? `Задача "${selectedTodo.text}" отмечена как выполненная 🫡`
            : `Задача "${selectedTodo.text}" снова отмечена как невыполненная 😬`,
        );
      } else if (userState.editMode === DELETE_TODO_MODE) {
        userState.todos.splice(todoIndex, 1);
        await sendMessage(chatId, `Задача "${selectedTodo.text}" удалена 🗑️`);
      }

      await displayTodos(chatId);
      return;
    }

    if (callbackData === "toggle_mode") {
      userState.editMode =
        userState.editMode === COMPLETE_TODO_MODE
          ? DELETE_TODO_MODE
          : COMPLETE_TODO_MODE;

      await displayTodos(chatId);
      return;
    }

    if (callbackData === "set_reminder") {
      await sendMessage(
        chatId,
        "Выбери время для напоминания или отключи их:",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "30 сек", callback_data: "remind_30sec" }],
              [{ text: "10 мин", callback_data: "remind_10min" }],
              [{ text: "20 мин", callback_data: "remind_20min" }],
              [{ text: "30 мин", callback_data: "remind_30min" }],
              [{ text: "45 мин", callback_data: "remind_45min" }],
              [{ text: "1 час", callback_data: "remind_1hour" }],
              [{ text: "Отключить напоминания", callback_data: "remind_off" }],
            ],
          },
        },
      );
      return;
    }

    if (callbackData === "remind_off") {
      await stopReminder(chatId);
      await displayTodos(chatId);
      return;
    }

    if (callbackData.startsWith("remind_")) {
      const reminderInterval = getReminderIntervalFromCallback(callbackData);

      if (reminderInterval) {
        await setGlobalReminder(chatId, reminderInterval);
        await displayTodos(chatId);
      }

      return;
    }

    if (callbackData === "show_weather") {
      await showWeatherMenu(chatId);
      return;
    }

    if (callbackData === "show_saved_weather") {
      if (!userState.savedWeatherCity) {
        await startWeatherQuery(chatId);
        return;
      }

      await handleWeatherRequest(chatId, userState.savedWeatherCity);
      return;
    }

    if (callbackData === "change_weather_city") {
      await startWeatherQuery(chatId, "Укажи новый город для прогноза погоды.");
      return;
    }

    if (callbackData === "weekly_weather") {
      if (!userState.savedWeatherCity) {
        await startWeatherQuery(chatId);
        return;
      }

      const weeklyForecastResult = await getWeeklyWeather(
        userState.savedWeatherCity,
      );

      if (
        weeklyForecastResult.type === "API_ERROR" ||
        weeklyForecastResult.type === "NETWORK_ERROR"
      ) {
        await sendMessage(
          chatId,
          "Упс, не удалось получить прогноз на неделю. Переключаю обратно в режим заметок.",
        );
        await displayTodos(chatId);
        return;
      }

      await sendMessage(chatId, weeklyForecastResult.message, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Показать текущую погоду",
                callback_data: "show_saved_weather",
              },
            ],
            [
              {
                text: "Выбрать другой город",
                callback_data: "change_weather_city",
              },
            ],
          ],
        },
      });
    }
  } catch (error) {
    logError(
      `Failed to process callback "${callbackData}" for chat ${chatId}`,
      error,
    );
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  try {
    const userState = getUserState(chatId);

    if (!text) {
      return;
    }

    const normalizedText = text.trim();

    if (normalizedText === "/start") {
      return;
    }

    if (normalizedText === "/weather") {
      await showWeatherMenu(chatId);
      return;
    }

    if (userState.awaitingCity) {
      await handleWeatherRequest(chatId, normalizedText);
      return;
    }

    if (normalizedText.startsWith("/")) {
      return;
    }

    if (!normalizedText) {
      await sendMessage(chatId, "Пустую задачу добавить нельзя.");
      return;
    }

    userState.todos.push({
      text: normalizedText,
      isCompleted: false,
    });

    await sendMessage(chatId, `Добавлена задача: ${normalizedText}`);
    await displayTodos(chatId);
  } catch (error) {
    logError(`Failed to process message for chat ${chatId}`, error);
  }
});

function clearAllReminders() {
  Object.values(usersState).forEach((userState) => {
    if (userState.reminderIntervalId) {
      clearInterval(userState.reminderIntervalId);
      userState.reminderIntervalId = null;
    }
    userState.reminderIntervalMs = null;
  });
}

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logInfo(`Shutting down bot (${signal})`);
  clearAllReminders();

  try {
    await bot.stopPolling();
  } catch (error) {
    logError("Failed to stop polling cleanly", error);
  }

  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("uncaughtException", (error) => {
  logError("Uncaught exception", error);
  void shutdown("uncaughtException", 1);
});

process.once("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
  void shutdown("unhandledRejection", 1);
});

bot.on("polling_error", (error) => {
  logError("Telegram polling error", error);
});

async function startBot() {
  try {
    await bot.startPolling();
    logInfo("Telegram bot started in polling mode");
  } catch (error) {
    logError("Failed to start Telegram polling", error);
    await shutdown("startup_failure", 1);
  }
}

await startBot();
