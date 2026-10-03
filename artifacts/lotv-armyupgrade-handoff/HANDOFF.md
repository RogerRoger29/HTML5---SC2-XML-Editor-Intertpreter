# LotV Army Upgrade category expansion

This package contains one installable layout, `LotV_ArmyUpgradeOverride.SC2Layout`. It is based on the override used by the KoE `pstory01.SC2Map` and adds `CategoryButton11` through `CategoryButton14` to the `CategoryList` inside `ArmyUpgradeOverrideTemplate`. The four new buttons use the same Blizzard category-button template as buttons 1 through 10. They occupy a second column, to the right of the original stack, and start visible but disabled until the trigger initializes their categories.

## Install the layout

Replace the existing `Base.SC2Data/UI/Layout/LotV_ArmyUpgradeOverride.SC2Layout` in the mod or map that actually creates the Army Upgrade dialog. If your override has other edits, merge only the new `CategoryList` block instead of replacing the whole file. Its `DescIndex.SC2Layout` should include this override once.

Do not install the supplied `LotV_ArmyUpgrade.SC2Layout` from the earlier ZIP alongside this file. That file edits `LotV_ArmyUpgradeUI/ArmyUpgradeTemplate`, while the KoE trigger creates `LotV_ArmyUpgradeOverride/ArmyUpgradeOverrideTemplate`. Adding both as separate overrides can also produce duplicate layout namespace errors. If duplicate `desc` errors remain, check all map/mod dependencies and both `DescIndex` includes and `PreloadLayout` calls for another copy of either layout namespace.

## Trigger changes shown by `pstory01`

Make these changes in the Trigger Editor source and save the map normally. `MapScript.galaxy` is generated output.

1. In the map's `PUC_ArmyCategoryCountMaxOverride` constant, change **10 to 14**. The category control, label, icon, reminder, category-ID, selected-unit, and two-dimensional unit arrays all use `max + 1`; changing this constant expands them together. The `PU_ArmyCreateDialogOverride` hookup loop and the category selection and hover loops also use this constant, so they will visit buttons 11 through 14 after regeneration.
2. In `PU_ArmyInitDialogFromDataOverride`, add four category assignments after the current tenth (`Carrier`). For each index 11 through 14, assign a real `CArmyCategory` catalog ID to `gv_pU_ArmyCategoriesOverride[index]`, then show and enable `gv_pU_ArmyCategoryButtonsOverride[index]` in the same pattern as the existing ten. Replace `<CategoryId11>` through `<CategoryId14>` below with your actual IDs:

   ```galaxy
   lv_categoryIndex += 1;
   lv_indexArmyCategory = "<CategoryId11>";
   gv_pU_ArmyCategoriesOverride[lv_categoryIndex] = lv_indexArmyCategory;
   DialogControlSetVisible(gv_pU_ArmyCategoryButtonsOverride[lv_categoryIndex], PlayerGroupAll(), true);
   DialogControlSetEnabled(gv_pU_ArmyCategoryButtonsOverride[lv_categoryIndex], PlayerGroupAll(), true);
   ```

   Repeat that GUI action sequence for 12, 13, and 14. This is a model of the generated Galaxy, not a file to paste into `MapScript.galaxy`.
3. Add or verify four `CArmyCategory` catalog records with the same IDs. Each needs its intended `ArmyUnitArray` entries and the data used by the room's title, icon, state, and faction functions. The existing `PU_ArmyCategoryCountOverride` counts catalog categories that are both used by the UI and unlocked. Keep its result consistent with the initialized, contiguous category list. If some categories can be locked or dynamically unavailable, adjust the GUI initialization so it only shows and processes valid entries rather than blindly showing all 14.
4. Check the unit-choice limit separately. `PUC_ArmyChoiceCountOverride` is **16** in this `pstory01` version. It controls the four faction-choice pages and each category's unit array. It does not need to become 14 just because there are 14 categories, but a category with more than 16 unit choices needs its own expansion.
5. Save in the Editor and confirm the regenerated Galaxy creates `LotV_ArmyUpgradeOverride/ArmyUpgradeOverrideTemplate`, hooks `CategoryList`, loops to 14 in `PU_ArmyCreateDialogOverride`, and gives all four new `DialogControlHookup` calls nonzero control IDs. Test click and hover on 11 through 14 and verify each one displays the correct units.

The `HardlightBridgeControl` “too many CAbilBuild abilities” error in the screenshot is a separate catalog issue. This layout does not modify it.

## Evidence and limits

`pstory01` creates the override at `MapScript.galaxy:491`, hooks `CategoryList` at line 499, hooks category buttons in the loop at lines 501 through 524, and currently caps the loop at 10 at line 30. Its hardcoded category IDs occupy lines 613 through 662. The supplied ZIP placed 11 through 14 in `ArmyUpgradeTemplate` at lines 995 through 1012. This handoff places them under the runtime override at `ArmyUpgradeOverrideTemplate/CategoryList`.

The corrected file parses and round-trips byte-exact in SC2 UI Editor tests. The second-column placement is checked against the authored 1920 by 1080 layout coordinates, but the four new categories cannot be functionally tested without their actual catalog IDs and the recipient's updated Trigger Editor source. Verify the final arrangement in game at the target resolution.

## If Ctrl+Alt+F12 shows frames but no names or lock icons

That viewer confirms the layout descriptions exist. It does not confirm that the dialog trigger hooked or initialized them. The first handoff mistakenly set buttons 11 through 14 to `Visible=false`, so they appeared gray in the frame tree. This revision makes them visible and initially disabled. The inherited `ArmyCategoryButtonTemplate/LockIcon` still starts with `Visible=false` until the trigger reveals it.

In `pstory01`, `PU_ArmyCreateDialogOverride` hooks `CategoryButton1` through `CategoryButton10` because `PUC_ArmyCategoryCountMaxOverride` is 10. `PU_ArmyInitDialogFromDataOverride` shows the real category buttons, and its remaining-slot loop sets the `SelectLabel` to locked text and reveals `LockIcon`. `PU_ArmyUpdateDialogOverride` supplies each unlocked category's role and selected-unit name. The missing text and lock art are therefore expected when only the layout has been installed.

After setting the maximum to 14 and saving in the Editor, check that all four hookup IDs are nonzero. If the four new categories already have real IDs, extend the ten hardcoded category-assignment/show/enable blocks to fourteen. If the extra spaces are placeholders for future categories, leave them disabled and let the existing remaining-slot loop show the locked label and icon. Verify that the catalog count and the ordered category list agree before enabling click handling.
