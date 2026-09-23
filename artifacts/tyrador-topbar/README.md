# Knights of Tyrador Top Bar

This package contains a complete SC2 global-caster top bar with:

- four active ability slots in command-card columns 0 through 3;
- two passive information slots in columns 4 and 5;
- ten independently fillable energy milestones;
- an exact energy value label;
- a full-energy pulse driven by the final milestone;
- a custom Tyrador shell plus separate button backing, bezel, hover, and
  energy-fill textures in PNG source and game-ready DDS form.

## Files

- `TyradorTopBar.SC2Mod` is the ready-to-add dependency mod.
- `Tyrador_TopBar.SC2Layout` is the editable source layout.
- `Tyrador_TopBar_Integration.galaxy` is the runtime hookup reference.
- `demo/CombatSimulation_TyradorDemo.SC2Map` is the unpacked, directly
  launchable Combat Simulation demonstration copy.
- `assets/tyrador_topbar_shell.png` is the final transparent texture source.
- `assets/tyrador_topbar_shell.dds` is the DXT5 game texture.
- `assets/tyrador_button_backing.*` is the recessed layer below command icons.
- `assets/tyrador_button_frame.*` is the continuous Tyrador bezel above icons.
- `assets/tyrador_button_hover.*` is the active hover glow.
- `assets/tyrador_energy_fill.*` is the independently clipped milestone fill.

## Runtime contract

The package adds an `AMTTopBarTemplate` user-data instance named `Tyrador`.
It points AMT at `Tyrador_TopBar/TyradorTopBar`,
`TyradorGlobalCommandPanel`, `EnergyProgressBar`, and `KoEGlobalCaster`.
It also carries KoE's Bio-Plague Strike, Shattered Reality, and Temporal
Field extended-ability registrations into AMT's targeting system.

After adding AMT, KoE, and `TyradorTopBar.SC2Mod` as dependencies, change the
KoE setup call from:

```galaxy
libB513D0A0_gf_InitTopBarForPlayer(1, "SpearOfAdun");
```

to:

```galaxy
libB513D0A0_gf_InitTopBarForPlayer(1, "Tyrador");
```

Run the normal KoE bank/perk setup before or immediately after that call.
AMT accepts one top-bar template per player, so do not call both template
names for the same player.

Every milestone represents ten percent of the caster's maximum energy and
turns on when that threshold is reached. AMT writes the caster's current and
maximum energy into the hidden `EnergyProgressBar`; the layout derives the ten
lights and exact number directly from it. No polling trigger is required.

The command card provides the icons, cooldowns, costs, disabled states,
tooltips, and clicks. The layout does not invent ability logic. KoE's current
caster defines two active choice cells and one passive choice cell, so the
other wells correctly remain empty. Future catalog work can use columns 2 and
3 for two more active groups and row 1, column 0 for a second passive group.
Do not populate that second passive well with a stock SoA choice unless KoE's
caster and campaign-perk data explicitly add that choice group.
