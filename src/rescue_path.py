"""
Rescue Path Finder (Stub)
=========================
Simplified version for resource allocation demonstration
"""

import numpy as np

class RescuePathFinder:
    def __init__(self, dem_path=None, risk_map_path=None):
        self.dem_path = dem_path
        self.risk_map_path = risk_map_path

    def find_path(self, start_coords, end_coords):
        """
        Stub: Calculate a simple straight-line distance as a proxy for travel time
        """
        # (lat, lon)
        dist = np.sqrt((start_coords[0] - end_coords[0])**2 + 
                       (start_coords[1] - end_coords[1])**2)
        
        # Assume average speed of 20km/h (333 m/min)
        # Convert lat/lon distance to approx meters (1 deg ~= 111km)
        dist_m = dist * 111000
        time_min = dist_m / 333
        
        return {
            'path': [start_coords, end_coords],
            'statistics': {
                'distance_m': round(dist_m, 1),
                'time_min': round(time_min, 1)
            }
        }
