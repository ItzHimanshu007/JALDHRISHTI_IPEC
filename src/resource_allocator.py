"""
Resource Allocation Optimizer
==============================
Optimally distribute rescue resources across affected areas
with village-specific terrain profiles and multi-phase deployment
"""

import numpy as np
from scipy.optimize import linear_sum_assignment
from typing import List, Dict, Tuple
import json
import os
from datetime import datetime

# Note: Dependency on geopandas and scipy.optimize.
# For demonstration purposes, we use simple data structures if GeoPandas is not available.

# =============================================
# VILLAGE TERRAIN PROFILES
# =============================================
VILLAGE_TERRAIN_PROFILES = {
    'wayanad_meppadi': {
        'name': 'Meppadi',
        'state': 'Kerala',
        'terrain_label': 'Hilly Western Ghats',
        'flood_type': 'Flash Flood & Landslide',
        'risk_factors': ['Landslide Risk', 'Flash Flood', 'Debris Flow'],
        'evacuation_advice': 'Move to higher ground immediately; avoid all valley floors',
        'deploy_priorities': ['helicopters', 'medical_kits', 'ambulances'],
        'terrain_multipliers': {'boats': 0.6, 'helicopters': 2.0, 'ambulances': 1.2, 'medical_kits': 1.5},
        'base_inventory': {'boats': 7, 'ambulances': 4, 'helicopters': 3, 'personnel': 55, 'relief_kits': 600, 'medical_kits': 300},
        'surge_multiplier': 1.5,
        'special_notes': 'Landslide corridors require aerial reconnaissance before ground deployment.'
    },
    'darbhanga': {
        'name': 'Darbhanga',
        'state': 'Bihar',
        'terrain_label': 'Riverine Plain (Kamla-Balan Basin)',
        'flood_type': 'River Overflow & Embankment Breach',
        'risk_factors': ['River Overflow', 'Embankment Breach', 'Stagnant Water'],
        'evacuation_advice': 'Relocate to elevated community shelters; avoid embankments',
        'deploy_priorities': ['boats', 'relief_kits', 'personnel'],
        'terrain_multipliers': {'boats': 1.8, 'helicopters': 0.8, 'ambulances': 1.0, 'medical_kits': 1.0},
        'base_inventory': {'boats': 11, 'ambulances': 6, 'helicopters': 2, 'personnel': 85, 'relief_kits': 900, 'medical_kits': 400},
        'surge_multiplier': 1.3,
        'special_notes': 'Monitor Kamla embankment breach points. Stagnant water zones need purification kits.'
    },
    'dhemaji': {
        'name': 'Dhemaji',
        'state': 'Assam',
        'terrain_label': 'Brahmaputra Floodplain',
        'flood_type': 'Sheet Flooding & Bank Erosion',
        'risk_factors': ['River Swell', 'Bank Erosion', 'Widespread Sheet Flooding'],
        'evacuation_advice': 'Move to raised platforms (Chang Ghars) or designated high ground',
        'deploy_priorities': ['boats', 'helicopters', 'relief_kits'],
        'terrain_multipliers': {'boats': 2.0, 'helicopters': 1.2, 'ambulances': 0.8, 'medical_kits': 1.3},
        'base_inventory': {'boats': 16, 'ambulances': 5, 'helicopters': 3, 'personnel': 115, 'relief_kits': 800, 'medical_kits': 350},
        'surge_multiplier': 1.4,
        'special_notes': 'Activate Chang Ghar network. Riverbank erosion may isolate communities.'
    }
}


class ResourceAllocator:
    """
    Optimize distribution of rescue resources
    """
    
    def __init__(self, rescue_centers: List[Tuple[float, float]],
                 affected_clusters,
                 pathfinder,
                 village_id: str = 'wayanad_meppadi'):
        """
        Parameters:
        -----------
        rescue_centers : list of (lat, lon)
            Available resource staging locations
        affected_clusters : GeoDataFrame or list of dicts
            Population clusters requiring assistance
        pathfinder : RescuePathFinder
            For calculating travel times
        village_id : str
            Village identifier for terrain-specific allocation
        """
        self.centers = rescue_centers
        self.clusters = affected_clusters
        self.pathfinder = pathfinder
        self.village_id = village_id
        self.terrain_profile = VILLAGE_TERRAIN_PROFILES.get(village_id, VILLAGE_TERRAIN_PROFILES['wayanad_meppadi'])
        
        # Calculate distance/time matrix
        self.cost_matrix = self._build_cost_matrix()
    
    def _build_cost_matrix(self):
        """
        Build cost matrix: cost[i,j] = time from center i to cluster j
        """
        n_centers = len(self.centers)
        n_clusters = len(self.clusters)
        
        cost_matrix = np.zeros((n_centers, n_clusters))
        
        for i, center in enumerate(self.centers):
            # Check if clusters is GeoDataFrame or list
            if hasattr(self.clusters, 'iterrows'):
                for j, cluster in self.clusters.iterrows():
                    target = (cluster.geometry.y, cluster.geometry.x)
                    result = self.pathfinder.find_path(center, target)
                    cost_matrix[i, j] = result['statistics']['time_min'] if "error" not in result else 9999
            else:
                for j, cluster in enumerate(self.clusters):
                    target = (cluster['lat'], cluster['lng'])
                    result = self.pathfinder.find_path(center, target)
                    cost_matrix[i, j] = result['statistics']['time_min'] if "error" not in result else 9999
        
        return cost_matrix
    
    def allocate_resources(self, n_resources: int, optimization_goal='min_max_time'):
        """
        Allocate resources to clusters
        """
        if optimization_goal == 'min_max_time':
            return self._allocate_min_max_time(n_resources)
        elif optimization_goal == 'min_avg_time':
            return self._allocate_min_avg_time(n_resources)
        else:
            return self._allocate_min_max_time(n_resources)
    
    def _allocate_min_max_time(self, n_resources):
        """
        Minimize maximum response time (fairness-based)
        """
        assignments = []
        n_clusters = len(self.clusters)
        cluster_assigned = np.full(n_clusters, False)
        cluster_response_times = np.full(n_clusters, np.inf)
        
        for _ in range(n_resources):
            worst_cluster = None
            worst_time = -1
            
            for j in range(n_clusters):
                if not cluster_assigned[j]:
                    best_time = np.min(self.cost_matrix[:, j])
                    if best_time > worst_time:
                        worst_time = best_time
                        worst_cluster = j
            
            if worst_cluster is None:
                break
            
            best_center = np.argmin(self.cost_matrix[:, worst_cluster])
            assignments.append((best_center, worst_cluster))
            cluster_assigned[worst_cluster] = True
            cluster_response_times[worst_cluster] = self.cost_matrix[best_center, worst_cluster]
        
        assigned_times = cluster_response_times[cluster_assigned]
        
        # Population calculation helper
        def get_total_pop(indices):
            if hasattr(self.clusters, 'iloc'):
                return int(self.clusters.iloc[indices]['population'].sum())
            return sum(self.clusters[i]['population'] for i in indices)

        assigned_indices = np.where(cluster_assigned)[0]

        return {
            'assignments': assignments,
            'max_response_time': float(np.max(assigned_times)) if len(assigned_times) > 0 else np.inf,
            'avg_response_time': float(np.mean(assigned_times)) if len(assigned_times) > 0 else np.inf,
            'clusters_covered': int(np.sum(cluster_assigned)),
            'coverage_population': get_total_pop(assigned_indices)
        }

    def _allocate_min_avg_time(self, n_resources):
        """
        Minimize average response time (efficiency-based)
        """
        n_clusters = len(self.clusters)
        if n_resources >= n_clusters:
            row_ind, col_ind = linear_sum_assignment(self.cost_matrix)
            assignments = list(zip(row_ind[:n_resources], col_ind[:n_resources]))
        else:
            # Subset based on population priority
            if hasattr(self.clusters, 'sort_values'):
                sorted_indices = self.clusters['population'].sort_values(ascending=False).index[:n_resources]
            else:
                sorted_indices = sorted(range(n_clusters), key=lambda i: self.clusters[i]['population'], reverse=True)[:n_resources]
            
            subset_cost = self.cost_matrix[:, sorted_indices]
            row_ind, col_ind = linear_sum_assignment(subset_cost)
            assignments = [(row_ind[i], sorted_indices[col_ind[i]]) for i in range(len(row_ind))]
        
        response_times = [self.cost_matrix[center, cluster] for center, cluster in assignments]
        covered_clusters = [cluster for _, cluster in assignments]
        
        def get_total_pop(indices):
            if hasattr(self.clusters, 'iloc'):
                return int(self.clusters.iloc[indices]['population'].sum())
            return sum(self.clusters[i]['population'] for i in indices)
            
        return {
            'assignments': assignments,
            'max_response_time': float(np.max(response_times)),
            'avg_response_time': float(np.mean(response_times)),
            'clusters_covered': len(assignments),
            'coverage_population': get_total_pop(covered_clusters)
        }

    def generate_deployment_plan(self, resources: Dict[str, int]):
        plan = {
            'village_id': self.village_id,
            'terrain_profile': self.terrain_profile,
            'resource_allocations': {},
            'deployment_sequence': [],
            'deployment_phases': {
                'phase1': {'name': 'IMMEDIATE RESPONSE', 'timeframe': '0-4 hours', 'missions': []},
                'phase2': {'name': 'SHORT-TERM RELIEF', 'timeframe': '4-12 hours', 'missions': []},
                'phase3': {'name': 'SUSTAINED OPERATIONS', 'timeframe': '12-24 hours', 'missions': []}
            },
            'estimated_coverage': {},
            'recommendations': []
        }
        
        for resource_type, count in resources.items():
            if count == 0: continue
            plan['resource_allocations'][resource_type] = self.allocate_resources(count)
        
        # Sort clusters by population (List or GeoDataFrame)
        if hasattr(self.clusters, 'sort_values'):
            sorted_clusters = self.clusters.sort_values('population', ascending=False)
            cluster_list = [(idx, row) for idx, row in sorted_clusters.iterrows()]
        else:
            cluster_list = sorted(enumerate(self.clusters), key=lambda x: x[1]['population'], reverse=True)

        for i, (idx, cluster) in enumerate(cluster_list):
            population = cluster['population'] if isinstance(cluster, dict) else cluster.population
            cluster_id = cluster['cluster_id'] if isinstance(cluster, dict) else cluster.cluster_id
            risk = cluster.get('risk', 0) if isinstance(cluster, dict) else getattr(cluster, 'risk', 0)
            
            # Assign urgency tier
            if risk > 0.7:
                urgency = 'CRITICAL'
                phase = 'phase1'
            elif risk > 0.4:
                urgency = 'URGENT'
                phase = 'phase2'
            else:
                urgency = 'MODERATE'
                phase = 'phase3'
            
            cluster_plan = {
                'cluster_id': cluster_id,
                'population': population,
                'priority_rank': i + 1,
                'urgency': urgency,
                'phase': phase,
                'resources_needed': self._estimate_resources_needed(population)
            }
            plan['deployment_sequence'].append(cluster_plan)
            plan['deployment_phases'][phase]['missions'].append(cluster_plan)
        
        total_pop = sum(c['population'] if isinstance(c, dict) else c.population for c in (self.clusters if not hasattr(self.clusters, 'iterrows') else [r for _, r in self.clusters.iterrows()]))
        
        for resource_type, allocation in plan['resource_allocations'].items():
            coverage_pct = 100 * allocation['coverage_population'] / total_pop if total_pop > 0 else 0
            plan['estimated_coverage'][resource_type] = {
                'population': allocation['coverage_population'],
                'percentage': round(coverage_pct, 1),
                'clusters': allocation['clusters_covered']
            }
        
        plan['recommendations'] = self._generate_recommendations(plan, resources)
        return plan

    def _estimate_resources_needed(self, population):
        tMult = self.terrain_profile.get('terrain_multipliers', {})
        return {
            'ambulances': max(1, int(np.ceil(population / 100 * tMult.get('ambulances', 1)))),
            'boats': max(1, int(np.ceil(population / 200 * tMult.get('boats', 1)))),
            'helicopters': max(0, int(np.ceil(population / 500 * tMult.get('helicopters', 1)))),
            'relief_kits': int(np.ceil(population / 5)),
            'medical_kits': int(np.ceil(population / 20 * tMult.get('medical_kits', 1)))
        }

    def _generate_recommendations(self, plan, available_resources):
        recs = []
        profile = self.terrain_profile
        
        # General shortage alerts
        for res, cov in plan['estimated_coverage'].items():
            if cov['percentage'] < 50:
                recs.append({'type': 'CRITICAL', 'message': f"Critical shortage of {res}. Only {cov['percentage']}% population covered."})
            elif cov['percentage'] < 75:
                recs.append({'type': 'WARNING', 'message': f"Partial coverage of {res}: {cov['percentage']}%. Consider requesting additional supplies."})
        
        # Village-specific terrain alerts
        village = self.village_id
        if village == 'wayanad_meppadi':
            recs.append({'type': 'WARNING', 'message': 'LANDSLIDE ALERT: Chooralmala–Mundakkai corridor requires aerial scanning before ground deployment.'})
            recs.append({'type': 'INFO', 'message': 'Hilly terrain prioritizes helicopter and medical kit deployment over ground vehicles.'})
        elif village == 'darbhanga':
            recs.append({'type': 'WARNING', 'message': 'EMBANKMENT WATCH: Monitor Kamla river embankment breach points. Deploy sandbag teams.'})
            recs.append({'type': 'INFO', 'message': 'Riverine terrain prioritizes boat deployment and community shelter activation.'})
        elif village == 'dhemaji':
            recs.append({'type': 'WARNING', 'message': 'CHANG GHAR ALERT: Activate raised platform network for local sheltering across floodplain.'})
            recs.append({'type': 'INFO', 'message': 'Floodplain terrain requires maximum boat fleet with aerial backup.'})
        
        return recs

    def generate_phased_deployment(self, resources: Dict[str, int]):
        """
        Generate a multi-phase deployment plan with tactical recommendations
        """
        base_plan = self.generate_deployment_plan(resources)
        
        # Compute phase summaries
        for phase_key, phase_data in base_plan['deployment_phases'].items():
            total_pop = sum(m['population'] for m in phase_data['missions'])
            phase_data['total_population'] = total_pop
            phase_data['cluster_count'] = len(phase_data['missions'])
            phase_data['resource_needs'] = {}
            for m in phase_data['missions']:
                for res, amt in m['resources_needed'].items():
                    phase_data['resource_needs'][res] = phase_data['resource_needs'].get(res, 0) + amt
        
        base_plan['deploy_priorities'] = self.terrain_profile.get('deploy_priorities', [])
        return base_plan

    def export_deployment_report(self, resources: Dict[str, int], output_path: str = None):
        """
        Generate and export a formatted deployment report as a text file
        """
        plan = self.generate_phased_deployment(resources)
        profile = self.terrain_profile
        
        res_labels = {
            'ambulances': 'Ambulances', 'boats': 'Rescue Boats', 'helicopters': 'Helicopters',
            'personnel': 'Personnel', 'relief_kits': 'Relief Kits', 'medical_kits': 'Medical Kits'
        }
        
        sep = '═' * 75
        dash = '─' * 75
        lines = []
        
        lines.append(sep)
        lines.append('             JAL DRISHTI — TACTICAL RESOURCE DEPLOYMENT REPORT')
        lines.append(sep)
        lines.append('')
        lines.append(f"Generated:       {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"Location:        {profile['name']}, {profile['state']}")
        lines.append(f"Terrain:         {profile['terrain_label']}")
        lines.append(f"Flood Type:      {profile['flood_type']}")
        lines.append('')
        
        # Terrain Profile
        lines.append(dash)
        lines.append('  SECTION 1: VILLAGE TERRAIN PROFILE')
        lines.append(dash)
        lines.append(f"  Risk Factors:       {', '.join(profile['risk_factors'])}")
        lines.append(f"  Evacuation Advice:  {profile['evacuation_advice']}")
        lines.append(f"  Deploy Priorities:  {' → '.join(res_labels.get(p, p) for p in profile.get('deploy_priorities', []))}")
        lines.append(f"  Special Notes:      {profile.get('special_notes', '--')}")
        lines.append('')
        
        # Resource Coverage
        lines.append(dash)
        lines.append('  SECTION 2: RESOURCE COVERAGE')
        lines.append(dash)
        for res, cov in plan['estimated_coverage'].items():
            lines.append(f"  {res_labels.get(res, res):18s}  Coverage: {cov['percentage']:5.1f}%  |  Pop: {cov['population']:>6}  |  Clusters: {cov['clusters']}")
        lines.append('')
        
        # Phased Deployment
        lines.append(dash)
        lines.append('  SECTION 3: PHASED DEPLOYMENT SCHEDULE')
        lines.append(dash)
        for key, phase in plan['deployment_phases'].items():
            lines.append(f"  ● {phase['name']} ({phase['timeframe']})")
            lines.append(f"    Clusters: {phase.get('cluster_count', 0)}  |  Population: {phase.get('total_population', 0):,}")
            for m in phase['missions']:
                lines.append(f"    → Cluster {m['cluster_id']} (Pop: {m['population']:,}, {m['urgency']})")
            lines.append('')
        
        # Recommendations
        lines.append(dash)
        lines.append('  SECTION 4: TACTICAL RECOMMENDATIONS')
        lines.append(dash)
        for rec in plan['recommendations']:
            lines.append(f"  [{rec['type']}] {rec['message']}")
        lines.append('')
        
        lines.append(sep)
        lines.append('         Report generated by Jal Drishti Mission Control v1.0')
        lines.append(sep)
        
        report_text = '\n'.join(lines)
        
        if output_path:
            with open(output_path, 'w') as f:
                f.write(report_text)
        
        return report_text

    def export_geojson(self, allocation, output_path):
        features = []
        for center_idx, cluster_idx in allocation['assignments']:
            center = self.centers[center_idx]
            
            if hasattr(self.clusters, 'iloc'):
                cluster = self.clusters.iloc[cluster_idx]
                target_coords = [cluster.geometry.x, cluster.geometry.y]
                cluster_id = cluster.cluster_id
                pop = cluster.population
            else:
                cluster = self.clusters[cluster_idx]
                target_coords = [cluster['lng'], cluster['lat']]
                cluster_id = cluster['cluster_id']
                pop = cluster['population']

            features.append({
                'type': 'Feature',
                'geometry': {'type': 'LineString', 'coordinates': [[center[1], center[0]], target_coords]},
                'properties': {
                    'center_id': center_idx,
                    'cluster_id': cluster_id,
                    'population': pop,
                    'time_min': self.cost_matrix[center_idx, cluster_idx]
                }
            })
        
        with open(output_path, 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': features}, f)
