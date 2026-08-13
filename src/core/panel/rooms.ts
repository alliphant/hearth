/**
 * The guest-facing room set for the panel surface (/app/panel/).
 *
 * Placement comes from HA's area registry, resolved live via
 * `fetch_ha_area_map()`. This file carries only what the registry cannot know:
 * which rooms a guest is ever in, and the handful of entities filed under a
 * different HA area than the room a human would say they're standing in.
 *
 * Adding a room to the panel is one row here.
 */

export type RoomConfig = {
  /** HA area this room draws its entities from. */
  area: string;
  /**
   * Temperature shown as "this room". Most rooms have no sensor of their own.
   * A list is tried best-source-first, same rule as OUTDOOR_TEMP.
   */
  temp_sensor?: string | readonly string[];
  /** Entities filed under another area that belong on this room's panel. */
  extras?: string[];
  /** Entities in this area that a guest should never see. */
  exclude?: string[];
  /** Per-entity label overrides, for when the friendly name would mislead. */
  labels?: Record<string, string>;
  /**
   * Scenes pinned to the front of the pane, in this order, ahead of whatever
   * the time of day would otherwise rank first. For the handful of scenes a
   * room is actually *for* — the ones a person reaches for without thinking.
   */
  scene_priority?: string[];
  /** Off after dark = someone walks into the dark. Promoted to the top tile. */
  urgent_when_off_at_night?: string[];
  /**
   * The ONE entity in this room whose tile is a door to the media surface
   * (Plex browse + the Apple TV remote) rather than a play/pause button.
   *
   * Only rooms with a screen worth browsing to. A speaker is not a media
   * surface — the Loft does not want a poster grid. Deliberately singular: two
   * tiles leading to the same screen is clutter, so the room names its door and
   * every other media entity in it stays a plain play/pause.
   *
   * This lives here, not on the device, for the same reason everything else
   * does: the panel must not learn which rooms have televisions.
   */
  media_surface?: string;
};

export const HOUSE_TEMP = 'sensor.home_temperature';

/**
 * Outdoor temperature, BEST SOURCE FIRST.
 *
 * The WeatherFlow Tempest is a physical station on this property, so it is
 * ground truth; everything after it is a geocoded forecast for the area, which
 * is a different (and worse) claim when the panel says "outside". They disagree
 * by ~3 °F on a normal afternoon, and the panel was showing the forecast.
 *
 * HA's core WeatherFlow integration names entities after the station SERIAL,
 * not "tempest" — hence the opaque id. If the hub is ever replaced, this is the
 * one line to change (`sensor.<new-serial>_temperature`).
 *
 * Resolution walks the list and takes the first source that is alive AND
 * FRESH — see `temp_of`. A dead station that HA keeps serving its last reading
 * for is the failure this ordering would otherwise introduce.
 */
export const OUTDOOR_TEMP: readonly string[] = [
  'sensor.st_00214775_temperature',
  'sensor.home_outdoor_temperature',
  'sensor.outdoor_temperature',
];

/**
 * The front door is the ONLY camera on this surface, and it only appears while
 * someone is actually there.
 *
 * A guest standing in the living room does not need a video of the living
 * room; a permanent camera pane on every tab is a surveillance view of the
 * house handed to a visitor, and it costs a ~300 KB frame every 10s on the one
 * surface that is supposed to stay cheap. A doorbell press is the single
 * moment a camera earns its place.
 */
export const DOORBELL = {
  /** Momentary press. */
  button: 'binary_sensor.front_door_doorbell',
  /** Someone lingering without pressing — same treatment, softer wording. */
  person: 'binary_sensor.front_door_person_detected',
  camera: 'camera.front_door_medium_resolution_channel',
  /** How long the card stays up after the sensor clears. */
  linger_ms: 90_000,
} as const;

export const ROOMS: Record<string, RoomConfig> = {
  'Front Foyer': {
    area: 'Front Foyer',
    extras: ['media_player.front_door_speaker'],
  },

  'Formal Space': {
    area: 'Formal Space',
    extras: ['media_player.foyer_speaker'],
  },

  'Living Room': {
    area: 'Living Room',
    extras: [
      'media_player.living_room_speaker',
      // Hue ships eight stock scenes per room and neither of these is among
      // them, so both are Hearth-authored in HA's scenes.yaml (2026-08-03).
      // They carry no HA area, hence extras rather than area placement.
      'scene.living_room_full_warm_white',
      'scene.living_room_movie',
    ],
    // The temperature sensors filed under Living Room are the whole-house pair;
    // the strip already shows them, so they don't need to be tiles too.
    exclude: [HOUSE_TEMP, ...OUTDOOR_TEMP, 'light.loft'],
    labels: {
      'light.living_room': 'All living room lights',
      'scene.living_room_full_warm_white': 'Full warm white',
      'scene.living_room_movie': 'Watch a movie',
    },
    // The two you reach for without thinking, ahead of the time-of-day ranking.
    scene_priority: ['scene.living_room_full_warm_white', 'scene.living_room_movie'],
  },

  Kitchen: {
    area: 'Kitchen',
    labels: { 'light.kitchen': 'All kitchen lights', 'light.bar': 'Bar light' },
  },

  'Half Bath': {
    area: 'Half Bath',
    // light.left / .middle / .right are the three bulbs inside light.half_bath.
    exclude: ['light.left', 'light.middle', 'light.right'],
    labels: { 'light.half_bath': 'Half bath lights' },
  },

  Loft: {
    area: 'Loft',
    extras: ['media_player.loft_speaker'],
    labels: { 'light.loft_2': 'Loft lights' },
  },

  'Basement Game Area': {
    area: 'Basement Game Area',
    temp_sensor: 'sensor.basement_temperature',
    // The game area's own area holds one light; the scenes, the stairs switch
    // and the thermometer are all filed under Basement.
    extras: [
      'switch.basement_stairs',
      'scene.basement_bright',
      'scene.basement_dimmed',
      'scene.basement_nightlight',
      'scene.basement_relax',
      'scene.basement_disturbia',
      'scene.basement_emerald_flutter',
      'light.bottom_of_stairs',
    ],
    labels: {
      'switch.basement_stairs': 'Stairs light',
      'light.basement_game_area_main_lights': 'Game area lights',
    },
    urgent_when_off_at_night: ['switch.basement_stairs', 'light.bottom_of_stairs'],
  },

  Theater: {
    area: 'Theater',
    extras: ['media_player.marantz_cinema_50_3'],
    // The label describes the DESTINATION, not the device, because the tile no
    // longer toggles the device — it opens a screen.
    labels: { 'media_player.ht_a9_2': 'Watch something' },
    media_surface: 'media_player.ht_a9_2',
  },

  Backyard: {
    area: 'Backyard',
    temp_sensor: OUTDOOR_TEMP,
    labels: { 'switch.backyard_porch': 'Porch light' },
    urgent_when_off_at_night: ['switch.backyard_porch'],
  },
};

export const ROOM_ORDER = Object.keys(ROOMS);
