export type DpiTimings = {
    h_active_pixels: number;
    h_sync_polarity: number;
    h_front_porch: number;
    h_sync_pulse: number;
    h_back_porch: number;
    v_active_lines: number;
    v_sync_polarity: number;
    v_front_porch: number;
    v_sync_pulse: number;
    v_back_porch: number;
    v_sync_offset_a: number;
    v_sync_offset_b: number;
    pixel_rep: number;
    frame_rate: number;
    interlaced: number;
    aspect_ratio: number;
}
