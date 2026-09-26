"""
Tests for Resource Allocator
"""

import pytest
import numpy as np
from src.resource_allocator import ResourceAllocator
from src.rescue_path import RescuePathFinder


class TestResourceAllocator:
    """Test suite for the ResourceAllocator class."""

    def test_initialization(self, sample_clusters, sample_rescue_centers):
        """Test allocator initializes with valid data."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        assert allocator.cost_matrix.shape == (2, 3)
        assert np.all(allocator.cost_matrix >= 0)

    def test_min_max_allocation(self, sample_clusters, sample_rescue_centers):
        """Test fairness-based allocation covers worst-case cluster first."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        result = allocator.allocate_resources(2, optimization_goal="min_max_time")
        assert result["clusters_covered"] == 2
        assert result["max_response_time"] < np.inf
        assert result["avg_response_time"] > 0

    def test_min_avg_allocation(self, sample_clusters, sample_rescue_centers):
        """Test efficiency-based allocation minimizes average time."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        result = allocator.allocate_resources(2, optimization_goal="min_avg_time")
        assert result["clusters_covered"] == 2
        assert result["avg_response_time"] <= result["max_response_time"]

    def test_deployment_plan(self, sample_clusters, sample_rescue_centers):
        """Test full deployment plan generation."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        plan = allocator.generate_deployment_plan({"boats": 2, "ambulances": 1})
        assert "resource_allocations" in plan
        assert "deployment_sequence" in plan
        assert len(plan["deployment_sequence"]) == 3

    def test_zero_resources(self, sample_clusters, sample_rescue_centers):
        """Test allocation with zero resources."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        result = allocator.allocate_resources(0)
        assert result["clusters_covered"] == 0

    def test_excess_resources(self, sample_clusters, sample_rescue_centers):
        """Test allocation with more resources than clusters."""
        pathfinder = RescuePathFinder()
        allocator = ResourceAllocator(
            rescue_centers=sample_rescue_centers,
            affected_clusters=sample_clusters,
            pathfinder=pathfinder,
        )
        result = allocator.allocate_resources(10)
        assert result["clusters_covered"] == 3  # Can't assign more than clusters
