package io.timejump.chuanyue

import android.app.Activity
import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.View
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Status and navigation bars in the app's own theme (paper / day / night),
 * not the system's dark mode.
 *
 * Edge-to-edge is on and both bars are transparent; MainActivity pads
 * android.R.id.content by the system-bar insets, so what shows behind the bars
 * is that padding, i.e. the content view's (and window's) background. Painting
 * those with the theme's --bg makes the bars continue the page, and the
 * icons are switched to dark-on-light or light-on-dark to match. The default
 * starts with #EFE5CF (宣纸书卷) and dark=false so cold-start never paints black
 * or transparent bars before JS boots.
 */
internal object SystemBars {
    private const val PREFS = "system_bars"
    private const val DEFAULT_COLOR = 0xFFEFE5CF.toInt()
    private const val DEFAULT_DARK = false

    fun apply(activity: Activity, color: Int, dark: Boolean) {
        val window = activity.window
        window.setBackgroundDrawable(ColorDrawable(color))
        activity.findViewById<View>(android.R.id.content)?.setBackgroundColor(color)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // The bars now sit on a matching colour with the right icon contrast;
            // the system's own translucent scrim (3-button navigation) would only add a band.
            window.isNavigationBarContrastEnforced = false
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    fun remember(context: Context, color: Int, dark: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt("color", color).putBoolean("dark", dark).apply()
    }

    /** Applies the saved theme colour, defaulting to #EFE5CF (paper) on first cold launch. */
    fun restore(activity: Activity) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        apply(
            activity,
            prefs.getInt("color", DEFAULT_COLOR),
            prefs.getBoolean("dark", DEFAULT_DARK)
        )
    }
}
