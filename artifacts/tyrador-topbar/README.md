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

Create `Tyrador_TopBar/TyradorTopBar` inside
`UIContainer/FullscreenUpperContainer`. Hook `TyradorGlobalCommandPanel` to
the global caster unit group. Hook `EnergySegment00` through
`EnergySegment09` as progress bars and `EnergyValueLabel` as a label.

Every milestone represents ten percent of the caster's maximum energy. A
partial milestone receives a value between 0 and 100, which gives smooth
lighting while retaining the ten-step visual language. The number label
always displays the caster's real current energy rather than its percent.

The command card provides the icons, cooldowns, costs, disabled states,
tooltips, and clicks. The layout does not invent ability logic. Put the four
active buttons in command-card columns 0 through 3 and the two passive
buttons in columns 4 and 5 on the unit used as the global caster.
