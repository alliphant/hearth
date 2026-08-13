# Home Assistant Zones for FRIDAY/Hearth

Hearth's spatial awareness composes HA zones with the Places vault
namespace. HA holds the spatial definition (lat/lon/radius); the vault
holds the rich metadata (parking notes, hours, history, who you usually
see there).

## Setup steps

1. Open Home Assistant → Settings → Areas & Zones → Zones
2. Confirm `Home` zone exists with reasonable radius (50-100m)
3. Add zones for your significant places:
   - Work (if applicable)
   - the clinic VTH (Bailey's vet)
   - Tony's Barbershop (or your barber)
   - Mom's house / family members you visit often
   - Frequently-used grocery store
   - Anywhere you spend >2 hours/week
4. Use the place's exact address; HA geocodes the rest
5. Radius guidance:
   - Precise indoor place (vet, dentist): 50m
   - Building with parking: 100m
   - Neighborhood/district: 200-500m
6. Each zone you create here should have a matching Places/<name>.md
   note in your vault (created via Kate when you first mention
   the place, or by you in Obsidian). The note holds the rich
   metadata; the zone holds the spatial trigger.

## Verification

Once zones are set, the HA Companion app reports your current
zone in `device_tracker.<your_phone>` state field. Test by:

```
curl -H "Authorization: Bearer $HA_TOKEN" \
     http://<ha_host>:8123/api/states/device_tracker.<your_phone>
```

Expect to see the zone name (or `not_home` if you're outside any
defined zone).
